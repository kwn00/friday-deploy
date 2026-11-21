import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { describe, it } from 'node:test';
import pg from 'pg';
import { Leaderboard, compareRuns, type RunRecord } from './leaderboard';
import { createPostgresStore } from './store-postgres';

/**
 * 진짜 PostgreSQL 이 있어야 돌아가는 테스트.
 *  - TEST_DATABASE_URL: 테스트용 DB 주소 (없으면 전부 건너뛴다)
 *  - TEST_PG_CTL: 실행 파일 경로. `<경로> stop` / `<경로> start` 로 DB 서버를 껐다 켤 수 있어야 한다
 *    (없으면 DB 를 끄는 테스트만 건너뛴다)
 */
const URL = process.env.TEST_DATABASE_URL;
const CTL = process.env.TEST_PG_CTL;
const skipAll = URL ? false : 'TEST_DATABASE_URL 이 없어 PostgreSQL 테스트를 건너뜁니다';
const skipCtl = skipAll || (CTL ? false : 'TEST_PG_CTL 이 없어 DB 를 껐다 켜는 테스트를 건너뜁니다');

const ctl = (cmd: 'start' | 'stop') => void execFileSync(CTL!, [cmd], { stdio: 'pipe' });

/** 테스트끼리 데이터가 섞이지 않게 시즌 번호를 무작위로 잡는다 */
const newSeason = () => 1_000 + Math.floor(Math.random() * 2_000_000_000);

let counter = 0;
function run(season: number, over: Partial<RunRecord> = {}): RunRecord {
  return { id: `t${Date.now()}-${counter++}-${Math.random().toString(36).slice(2, 8)}`, board: 'solo', season, names: ['가나다'], time: 100, kills: 5, level: 3, pausedSeconds: 0, endedAt: 1_700_000_000_000, ...over };
}

function randomRuns(season: number, n: number): RunRecord[] {
  const out: RunRecord[] = [];
  for (let i = 0; i < n; i++) {
    // 값의 범위를 좁게 잡아 동점이 많이 생기게 한다
    out.push(run(season, { time: 60 + Math.floor(Math.random() * 6), kills: Math.floor(Math.random() * 4), level: 1 + Math.floor(Math.random() * 3), endedAt: 1_700_000_000_000 + Math.floor(Math.random() * 4) }));
  }
  return out;
}

/** 처리되지 않은 예외·거부가 하나라도 생기면 기록해 둔다 (프로세스가 죽지 않았는지 확인용) */
function watchCrashes(): { events: unknown[]; stop: () => void } {
  const events: unknown[] = [];
  const onErr = (e: unknown) => void events.push(e);
  process.on('uncaughtException', onErr);
  process.on('unhandledRejection', onErr);
  return {
    events,
    stop: () => {
      process.off('uncaughtException', onErr);
      process.off('unhandledRejection', onErr);
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 연결 풀러(PgBouncer) 흉내. 호스팅 DB 가 기본으로 주는 "풀링" 주소(Neon 의 -pooler 호스트 등)는 PgBouncer 를 거치는데,
 * PgBouncer 는 자기가 추적하는 접속 매개변수만 받고 나머지(statement_timeout, options 등)가 있으면 접속을 거부한다.
 * 여기서는 그 검사만 똑같이 하고, 통과하면 진짜 DB 로 그대로 중계한다.
 */
const POOLER_ALLOWS = new Set(['user', 'database', 'client_encoding', 'datestyle', 'timezone', 'standard_conforming_strings', 'application_name']);
async function startPooler(target: { host: string; port: number }): Promise<{ port: number; refused: string[]; close: () => Promise<void> }> {
  const refused: string[] = [];
  const sockets = new Set<net.Socket>();
  const cstr = (text: string) => Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 8 || buf.length < buf.readInt32BE(0)) return;
      client.off('data', onData);
      // StartupMessage: 길이, 프로토콜 버전, 그 뒤로 "이름\0값\0" 이 이어지고 \0 으로 끝난다
      const parts = buf.subarray(8, buf.readInt32BE(0) - 1).toString('utf8').split('\0');
      const bad = parts.filter((_, i) => i % 2 === 0).filter((name) => name && !POOLER_ALLOWS.has(name));
      if (bad.length > 0) {
        refused.push(...bad);
        const fields = Buffer.concat([cstr('SFATAL'), cstr('VFATAL'), cstr('C08P01'), cstr(`Munsupported startup parameter: ${bad[0]}`), Buffer.from([0])]);
        const head = Buffer.alloc(5);
        head.write('E');
        head.writeInt32BE(fields.length + 4, 1);
        client.end(Buffer.concat([head, fields]));
        return;
      }
      const upstream = net.connect(target.port, target.host);
      sockets.add(upstream);
      upstream.on('close', () => (sockets.delete(upstream), client.destroy()));
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.write(buf);
      client.pipe(upstream);
      upstream.pipe(client);
    };
    client.on('data', onData);
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  return {
    port: (server.address() as net.AddressInfo).port,
    refused,
    close: () =>
      new Promise<void>((res) => {
        for (const s of sockets) s.destroy();
        server.close(() => res());
      }),
  };
}
/** 테스트 DB 주소에서 호스트·포트만 바꾼 주소 */
function through(port: number): string {
  const u = new globalThis.URL(URL!);
  u.hostname = '127.0.0.1';
  u.port = String(port);
  return u.toString();
}
const targetOf = (): { host: string; port: number } => {
  const u = new globalThis.URL(URL!);
  return { host: u.hostname, port: Number(u.port || 5432) };
};

describe('PostgreSQL 저장소', { skip: skipAll }, () => {
  it('순서가 compareRuns 와 같다 (동점 포함 수백 건)', async () => {
    const store = await createPostgresStore(URL!);
    try {
      const season = newSeason();
      const runs = randomRuns(season, 300);
      for (const r of runs) await store.save(r);
      const got = await store.load('solo', season, 1000);
      assert.deepEqual(got, [...runs].sort(compareRuns));
    } finally {
      await store.close();
    }
  });

  it('limit 만큼만, 같은 순서의 앞부분을 돌려준다', async () => {
    const store = await createPostgresStore(URL!);
    try {
      const season = newSeason();
      const runs = randomRuns(season, 60);
      for (const r of runs) await store.save(r);
      assert.deepEqual(await store.load('solo', season, 7), [...runs].sort(compareRuns).slice(0, 7));
      assert.deepEqual(await store.load('solo', season, 0), []);
    } finally {
      await store.close();
    }
  });

  it('같은 id 를 두 번 저장해도 오류가 없고 중복되지 않는다 (처음 값이 유지된다)', async () => {
    const store = await createPostgresStore(URL!);
    try {
      const season = newSeason();
      const r = run(season);
      await store.save(r);
      await store.save(r);
      await store.save({ ...r, time: 9999 });
      assert.deepEqual(await store.load('solo', season, 10), [r]);
    } finally {
      await store.close();
    }
  });

  it('순위표와 시즌이 서로 섞이지 않는다', async () => {
    const store = await createPostgresStore(URL!);
    try {
      const s1 = newSeason();
      const s2 = s1 + 1;
      const a = run(s1, { board: 'solo' });
      const b = run(s1, { board: 'coop', names: ['가', '나'] });
      const c = run(s2, { board: 'solo' });
      for (const r of [a, b, c]) await store.save(r);
      assert.deepEqual(await store.load('solo', s1, 10), [a]);
      assert.deepEqual(await store.load('coop', s1, 10), [b]);
      assert.deepEqual(await store.load('solo', s2, 10), [c]);
      assert.deepEqual(await store.load('coop', s2, 10), []);
    } finally {
      await store.close();
    }
  });

  it('따옴표·역슬래시·SQL 조각·이모지·한글 이름이 그대로 돌아온다', async () => {
    const store = await createPostgresStore(URL!);
    try {
      const season = newSeason();
      const names = [`O'Brien`, 'a\\b\\\\c', `'; DROP TABLE leaderboard_runs; --`, '"quoted"', '{a,b}', '$1', '\\x41', '😀🧟‍♂️', '홍길동', 'NULL', ' 공백 '];
      const r = run(season, { names, board: 'coop' });
      await store.save(r);
      const [got] = await store.load('coop', season, 1);
      assert.deepEqual(got?.names, names);
      // 테이블이 멀쩡한지: 다른 기록도 계속 저장된다
      await store.save(run(season));
      assert.equal((await store.load('solo', season, 5)).length, 1);
    } finally {
      await store.close();
    }
  });

  it('저장소를 두 개 만들어도(재시작) 같은 데이터가 보인다', async () => {
    const season = newSeason();
    const runs = randomRuns(season, 20);
    const a = await createPostgresStore(URL!);
    for (const r of runs) await a.save(r);
    await a.close();
    const b = await createPostgresStore(URL!);
    try {
      assert.deepEqual(await b.load('solo', season, 100), [...runs].sort(compareRuns));
    } finally {
      await b.close();
    }
  });

  it('두 저장소가 동시에 처음 쓰여도(테이블 생성 경합) 문제없다', async () => {
    const stores = await Promise.all([createPostgresStore(URL!), createPostgresStore(URL!), createPostgresStore(URL!)]);
    try {
      const season = newSeason();
      await Promise.all(stores.map((s) => s.save(run(season))));
      assert.equal((await stores[0]!.load('solo', season, 10)).length, 3);
    } finally {
      await Promise.all(stores.map((s) => s.close()));
    }
  });

  it('Leaderboard + 저장소: 기록 → 재시작 → top 이 같다', async () => {
    const season = newSeason();
    const lb1 = new Leaderboard(await createPostgresStore(URL!), season);
    await lb1.init();
    assert.equal(lb1.persistent, true);
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 25; i++) {
      lb1.record({ id: `e2e-${season}-${i}`, board: i % 2 ? 'coop' : 'solo', names: i % 2 ? ['가', '나'] : ['O\'Brien'], time: 90 + (i % 7), kills: i % 5, level: 1 + (i % 3), pausedSeconds: 0, endedAt: t0 + i });
    }
    const before = { solo: lb1.top('solo'), coop: lb1.top('coop') };
    assert.ok(before.solo.length > 0 && before.coop.length > 0);
    // 밀린 저장이 끝나기를 기다렸다가 닫는다 (Leaderboard.close 는 이미 진행 중인 저장을 기다리지 않는다)
    for (let i = 0; i < 100 && lb1.unsaved > 0; i++) await sleep(50);
    assert.equal(lb1.unsaved, 0);
    await lb1.close();

    const lb2 = new Leaderboard(await createPostgresStore(URL!), season);
    await lb2.init();
    try {
      assert.equal(lb2.ready, true);
      assert.deepEqual(lb2.top('solo'), before.solo);
      assert.deepEqual(lb2.top('coop'), before.coop);
    } finally {
      await lb2.close();
    }
  });

  it('close() 를 두 번 불러도 괜찮고, 닫은 뒤의 호출은 reject 한다', async () => {
    const store = await createPostgresStore(URL!);
    await store.load('solo', newSeason(), 1);
    await store.close();
    await store.close();
    await assert.rejects(store.save(run(newSeason())));
    await assert.rejects(store.load('solo', 1, 1));
  });

  it('기록은 지우지 않는다: 순위표당 1000건을 넘게 저장해도 전부 남는다 (예전의 자동 정리는 없앴다)', async () => {
    const store = await createPostgresStore(URL!);
    try {
      const season = newSeason();
      const runs = randomRuns(season, 1100);
      for (let i = 0; i < runs.length; i += 50) await Promise.all(runs.slice(i, i + 50).map((r) => store.save(r)));
      await sleep(300);
      const got = await store.load('solo', season, 5000);
      assert.equal(got.length, 1100, `남은 기록 ${got.length}건`);
      assert.deepEqual(got, [...runs].sort(compareRuns));
    } finally {
      await store.close();
    }
  });
});

/**
 * 테스트만의 빈 데이터베이스. 표 전체를 보는 테스트(시즌 합치기 등)가 다른 테스트·다른 실행의 데이터와 섞이지 않게 한다.
 * CREATE DATABASE 권한이 없으면 null (그 테스트는 건너뛴다).
 */
async function freshDb(): Promise<{ url: string; drop: () => Promise<void> } | null> {
  const name = `fdtest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: URL! });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } catch {
    return null;
  } finally {
    await admin.end().catch(() => {});
  }
  const u = new globalThis.URL(URL!);
  u.pathname = `/${name}`;
  return {
    url: u.toString(),
    drop: async () => {
      const a = new pg.Client({ connectionString: URL! });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
      await a.end().catch(() => {});
    },
  };
}

/** 표 전체의 (시즌, 개수) 와 id 별 시즌 */
async function seasonsOf(url: string): Promise<{ count: number; byId: Map<string, number> }> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query<{ id: string; season: number }>('SELECT id, season FROM leaderboard_runs');
    return { count: r.rowCount ?? 0, byId: new Map(r.rows.map((x) => [x.id, x.season])) };
  } finally {
    await c.end();
  }
}

describe('PostgreSQL 저장소: 시즌 0 으로 합치기 (0.x = 시즌 0)', { skip: skipAll }, () => {
  it('지금 시즌이 0 이면 뜰 때 예전 시즌의 기록을 시즌 0 으로 합친다: 하나도 지우지 않고 내용도 그대로다', async (t) => {
    const db = await freshDb();
    if (!db) return t.skip('CREATE DATABASE 권한이 없어 건너뜁니다');
    try {
      // 예전 규칙의 시즌 1·2·3 기록과 이미 시즌 0 인 기록 (지금 시즌을 넘기지 않는 저장소로 넣는다: 시즌을 건드리지 않는다)
      const setup = await createPostgresStore(db.url);
      const legacy = [
        run(1, { id: 'a1', time: 111, names: ['일'], killsBy: [3], itemsBy: [[{ id: 'console_log', level: 2 }]] }),
        run(2, { id: 'a2', time: 222, board: 'coop', names: ['이', '삼'], killsBy: [1, 2] }),
        run(3, { id: 'a3', time: 333 }),
        run(0, { id: 'a0', time: 44 }),
        ...randomRuns(3, 1100), // 한 순위표가 1000건을 넘어도 지우지 않는다 (예전의 자동 정리는 없앴다)
      ];
      for (const r of legacy) await setup.save(r);
      await setup.close();
      assert.equal((await seasonsOf(db.url)).count, legacy.length);

      const store = await createPostgresStore(db.url, { currentSeason: 0 });
      try {
        const solo = await store.load('solo', 0, 100_000);
        const coop = await store.load('coop', 0, 100_000);
        const sort = (rows: RunRecord[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
        assert.deepEqual(sort([...solo, ...coop]), sort(legacy.map((r) => ({ ...r, season: 0 }))), '시즌 번호만 0 이 되고 이름·기여도·아이템·시간은 그대로');
        const after = await seasonsOf(db.url);
        assert.equal(after.count, legacy.length, '지운 기록이 없다');
        assert.ok([...after.byId.values()].every((x) => x === 0), '시즌 0 이 아닌 기록이 남지 않는다');
        assert.deepEqual(await store.seasons(), [0]);
      } finally {
        await store.close();
      }
    } finally {
      await db.drop();
    }
  });

  it('배포 중 예전 서버가 예전 시즌 번호로 남긴 기록도 다음에 뜰 때 합쳐진다. 지금 시즌을 넘기지 않으면 아무것도 바꾸지 않는다', async (t) => {
    const db = await freshDb();
    if (!db) return t.skip('CREATE DATABASE 권한이 없어 건너뜁니다');
    try {
      const first = await createPostgresStore(db.url, { currentSeason: 0 });
      await first.load('solo', 0, 1); // 새 서버가 떠서 합치기를 마쳤다
      await first.close();
      // 아직 내려가지 않은 예전 서버(시즌 3 번호를 쓴다)가 기록을 남긴다
      const old = await createPostgresStore(db.url);
      await old.save(run(3, { id: 'late', time: 77 }));
      await old.close();
      assert.equal((await seasonsOf(db.url)).byId.get('late'), 3, '지금 시즌을 넘기지 않은 저장소는 시즌을 건드리지 않는다');
      // 지금 시즌 0 인 서버가 다시 뜨면 합친다
      const next = await createPostgresStore(db.url, { currentSeason: 0 });
      await next.load('solo', 0, 1);
      await next.close();
      assert.equal((await seasonsOf(db.url)).byId.get('late'), 0);
    } finally {
      await db.drop();
    }
  });

  it('새 규칙의 시즌 1 로 떠 본 서버가 있으면, 0.x 를 다시 띄워도(롤백) 시즌 1 기록을 건드리지 않는다', async (t) => {
    const db = await freshDb();
    if (!db) return t.skip('CREATE DATABASE 권한이 없어 건너뜁니다');
    try {
      const zero = await createPostgresStore(db.url, { currentSeason: 0 });
      await zero.save(run(0, { id: 'z', time: 50 }));
      await zero.close();
      // 1.0.0 (시즌 1) 이 뜨고 기록을 남긴다
      const one = await createPostgresStore(db.url, { currentSeason: 1 });
      await one.save(run(1, { id: 's1', time: 90 }));
      await one.close();
      // 문제가 생겨 0.x 로 되돌렸다
      const rollback = await createPostgresStore(db.url, { currentSeason: 0 });
      assert.deepEqual((await rollback.load('solo', 0, 10)).map((r) => r.id), ['z']);
      await rollback.close();
      const after = await seasonsOf(db.url);
      assert.deepEqual([after.byId.get('s1'), after.byId.get('z'), after.count], [1, 0, 2], '시즌 1 기록은 시즌 1 그대로, 지운 것 없음');
      // 다시 1.x 로 오면 시즌 1 순위표가 그대로 보인다
      const again = await createPostgresStore(db.url, { currentSeason: 1 });
      assert.deepEqual((await again.load('solo', 1, 10)).map((r) => r.id), ['s1']);
      assert.deepEqual(await again.seasons(), [0, 1]);
      await again.close();
    } finally {
      await db.drop();
    }
  });
});

describe('PostgreSQL 저장소: 아이템 통계', { skip: skipAll }, () => {
  it('시즌·아이템마다 더해 가고, 다시 불러오면 같다. 세기 시작한 때는 가장 이른 것이다', async () => {
    const store = await createPostgresStore(URL!);
    try {
      const season = newSeason();
      assert.deepEqual(await store.loadStats(season), { runs: 0, since: null, upgrades: {} });
      await store.addStats(season, { runs: 2, since: 5000, upgrades: { console_log: { offered: 3, picked: 1, autoPicked: 1, chest: 2, finalOwned: 2, finalLevelSum: 7 } } }, `batch-1-${season}`);
      await store.addStats(season, {
        runs: 1,
        since: 4000,
        upgrades: { console_log: { offered: 1, picked: 1, autoPicked: 0, chest: 0, finalOwned: 1, finalLevelSum: 3 }, coffee: { offered: 2, picked: 0, autoPicked: 0, chest: 0, finalOwned: 0, finalLevelSum: 0 } },
      }, `batch-2-${season}`);
      await store.addStats(season + 1, { runs: 9, since: 1, upgrades: {} }, `batch-3-${season}`);
      const got = await store.loadStats(season);
      assert.deepEqual(got, {
        runs: 3,
        since: 4000,
        upgrades: {
          console_log: { offered: 4, picked: 2, autoPicked: 1, chest: 2, finalOwned: 3, finalLevelSum: 10 },
          coffee: { offered: 2, picked: 0, autoPicked: 0, chest: 0, finalOwned: 0, finalLevelSum: 0 },
        },
      });
      const seasons = await store.seasons();
      assert.ok(seasons.includes(season) && seasons.includes(season + 1), '통계만 있는 시즌도 시즌 목록에 들어간다');
      assert.deepEqual(seasons, [...seasons].sort((a, b) => a - b), '오름차순');
    } finally {
      await store.close();
    }
  });

  it('같은 묶음 id 로 다시 보내면 두 번 더하지 않는다 (확인 응답만 잃고 다시 보낸 경우)', async () => {
    const store = await createPostgresStore(URL!);
    try {
      const season = newSeason();
      const d = { runs: 2, since: 7, upgrades: { regex: { offered: 3, picked: 1, autoPicked: 1, chest: 0, finalOwned: 2, finalLevelSum: 5 } } };
      await store.addStats(season, d, `same-${season}`);
      await store.addStats(season, d, `same-${season}`);
      const got = await store.loadStats(season);
      assert.deepEqual([got.runs, got.upgrades.regex!.offered], [2, 3]);
      await store.addStats(season, d, `other-${season}`);
      assert.equal((await store.loadStats(season)).runs, 4, '다른 묶음은 더한다');
    } finally {
      await store.close();
    }
  });

  it('지금 게임에 없는 아이템의 줄은 읽을 때 건너뛴다 (이름이 바뀌었거나 빠진 아이템)', async () => {
    const admin = new pg.Client({ connectionString: URL! });
    await admin.connect();
    const store = await createPostgresStore(URL!);
    try {
      const season = newSeason();
      await store.addStats(season, { runs: 1, since: 1, upgrades: { regex: { offered: 1, picked: 1, autoPicked: 0, chest: 0, finalOwned: 1, finalLevelSum: 1 } } }, `batch-4-${season}`);
      await admin.query("INSERT INTO upgrade_stats (season, upgrade_id, offered) VALUES ($1, 'removed_weapon', 5)", [season]);
      assert.deepEqual(Object.keys((await store.loadStats(season)).upgrades), ['regex']);
    } finally {
      await store.close();
      await admin.end().catch(() => {});
    }
  });
});

describe('PostgreSQL 저장소: 개인별 기여도', { skip: skipAll }, () => {
  it('개인별 처치 수가 이름과 같은 순서로 저장되고 돌아온다. 없는 기록은 없는 대로 돌아온다', async () => {
    const store = await createPostgresStore(URL!);
    try {
      const season = newSeason();
      await store.save(run(season, { board: 'coop', names: ['많이', '적게', '중간'], killsBy: [40, 0, 7], kills: 47, time: 300 }));
      await store.save(run(season, { board: 'coop', names: ['예전', '기록'], time: 200 }));
      const rows = await store.load('coop', season, 5);
      assert.deepEqual(rows.map((r) => [r.names, r.killsBy]), [[['많이', '적게', '중간'], [40, 0, 7]], [['예전', '기록'], undefined]]);
    } finally {
      await store.close();
    }
  });

  it('열이 없던 예전 테이블에도 열이 더해지고, 그 전에 있던 기록은 그대로 읽힌다', async () => {
    const season = newSeason();
    const admin = new pg.Client({ connectionString: URL! });
    await admin.connect();
    try {
      // 예전 서버가 만든 테이블 모양으로 되돌리고, 예전 방식으로 한 줄 넣어 둔다
      await admin.query('CREATE TABLE IF NOT EXISTS leaderboard_runs (id text PRIMARY KEY, board text NOT NULL, season integer NOT NULL, names text[] NOT NULL, time integer NOT NULL, kills integer NOT NULL, level integer NOT NULL, paused_seconds integer NOT NULL, ended_at bigint NOT NULL)');
      await admin.query('ALTER TABLE leaderboard_runs DROP COLUMN IF EXISTS member_kills');
      await admin.query('INSERT INTO leaderboard_runs (id, board, season, names, time, kills, level, paused_seconds, ended_at) VALUES ($1, $2, $3, $4, 120, 9, 2, 0, 1700000000000)', [`old-${season}`, 'coop', season, ['옛날', '사람']]);
      const store = await createPostgresStore(URL!);
      try {
        const before = await store.load('coop', season, 5);
        assert.deepEqual(before.map((r) => [r.id, r.names, r.killsBy]), [[`old-${season}`, ['옛날', '사람'], undefined]]);
        await store.save(run(season, { id: `new-${season}`, board: 'coop', names: ['새', '기록'], killsBy: [3, 1], kills: 4, time: 130 }));
        const after = await store.load('coop', season, 5);
        assert.deepEqual(after.map((r) => [r.id, r.killsBy]), [[`new-${season}`, [3, 1]], [`old-${season}`, undefined]]);
      } finally {
        await store.close();
      }
      const cols = await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'leaderboard_runs' AND column_name = 'member_kills'");
      assert.equal(cols.rowCount, 1);
    } finally {
      await admin.end().catch(() => {});
    }
  });
});

describe('PostgreSQL 저장소: 개인별 아이템', { skip: skipAll }, () => {
  it('사람별 아이템이 이름과 같은 순서로 저장되고 돌아온다. 없는 기록은 없는 대로 돌아온다', async () => {
    const store = await createPostgresStore(URL!);
    try {
      const season = newSeason();
      const itemsBy = [[{ id: 'console_log' as const, level: 3 }, { id: 'coffee' as const, level: 2 }], []];
      await store.save(run(season, { board: 'coop', names: ['가', '나'], killsBy: [4, 1], itemsBy, kills: 5, time: 300 }));
      await store.save(run(season, { board: 'coop', names: ['예전', '기록'], time: 200 }));
      const rows = await store.load('coop', season, 5);
      assert.deepEqual(rows.map((r) => r.itemsBy), [itemsBy, undefined]);
    } finally {
      await store.close();
    }
  });

  it('member_items 열이 없던 테이블에도 열이 더해지고, 예전 기록은 아이템 없이 읽힌다. DB 에 이상한 값이 있어도 걸러 낸다', async () => {
    const season = newSeason();
    const admin = new pg.Client({ connectionString: URL! });
    await admin.connect();
    try {
      await admin.query('ALTER TABLE leaderboard_runs DROP COLUMN IF EXISTS member_items');
      await admin.query('INSERT INTO leaderboard_runs (id, board, season, names, time, kills, level, paused_seconds, ended_at) VALUES ($1, $2, $3, $4, 120, 9, 2, 0, 1700000000000)', [`old-${season}`, 'solo', season, ['옛날']]);
      const store = await createPostgresStore(URL!);
      try {
        assert.deepEqual((await store.load('solo', season, 5)).map((r) => [r.id, r.itemsBy]), [[`old-${season}`, undefined]]);
        await admin.query(`UPDATE leaderboard_runs SET member_items = $1 WHERE id = $2`, [JSON.stringify([[{ id: 'coffee', level: 99 }, { id: 'rubber_duck', level: 1 }]]), `old-${season}`]);
        assert.deepEqual((await store.load('solo', season, 5)).map((r) => r.itemsBy), [[[{ id: 'rubber_duck', level: 1 }]]]);
      } finally {
        await store.close();
      }
    } finally {
      await admin.end().catch(() => {});
    }
  });
});

describe('PostgreSQL 저장소: 서버가 뜰 때 테이블을 막지 않는다', { skip: skipAll }, () => {
  it('열과 인덱스가 이미 있으면, 다른 연결이 테이블을 읽거나 쓰는 중이어도 기다리지 않고 바로 준비된다', async () => {
    // 테이블·열·인덱스를 먼저 만들어 둔다
    const first = await createPostgresStore(URL!);
    const season = newSeason();
    await first.save(run(season, { time: 50 }));
    await first.close();
    // 다른 연결이 트랜잭션을 연 채로 읽고(ACCESS SHARE) 쓴(ROW EXCLUSIVE) 뒤 끝내지 않는다:
    // 뜰 때마다 ALTER TABLE(테이블 전체 잠금)이나 CREATE INDEX(쓰기 잠금)를 실행했다면 여기서 줄을 서게 된다
    const busy = new pg.Client({ connectionString: URL! });
    await busy.connect();
    try {
      await busy.query('BEGIN');
      await busy.query('SELECT count(*) FROM leaderboard_runs');
      await busy.query("INSERT INTO leaderboard_runs (id, board, season, names, time, kills, level, paused_seconds, ended_at) VALUES ($1, 'solo', $2, '{x}', 40, 1, 1, 0, 1)", [`busy-${season}`, season]);
      const store = await createPostgresStore(URL!, { statementTimeoutMs: 1500 });
      try {
        const t0 = Date.now();
        await store.save(run(season, { time: 60, killsBy: [5] }));
        const rows = await store.load('solo', season, 5);
        assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
        assert.deepEqual(rows.map((r) => r.time), [60, 50], '아직 끝나지 않은 다른 연결의 기록은 보이지 않는다');
      } finally {
        await store.close();
      }
      await busy.query('ROLLBACK');
    } finally {
      await busy.end().catch(() => {});
    }
  });

  it('열을 더해야 하는데 테이블이 잠겨 있으면 오래 버티지 않고 물러나고, 풀린 뒤에 다시 하면 된다', async () => {
    const season = newSeason();
    const admin = new pg.Client({ connectionString: URL! });
    const busy = new pg.Client({ connectionString: URL! });
    await admin.connect();
    await busy.connect();
    try {
      await admin.query('ALTER TABLE leaderboard_runs DROP COLUMN IF EXISTS member_kills');
      await busy.query('BEGIN');
      await busy.query('SELECT count(*) FROM leaderboard_runs');
      const store = await createPostgresStore(URL!);
      try {
        const t0 = Date.now();
        await assert.rejects(store.save(run(season, { time: 70, killsBy: [1] })), (err: Error & { code?: string }) => err.code === '55P03');
        assert.ok(Date.now() - t0 < 6000, `잠금을 ${Date.now() - t0}ms 기다렸다`);
        await busy.query('ROLLBACK');
        await store.save(run(season, { time: 70, killsBy: [1] }));
        assert.deepEqual((await store.load('solo', season, 5)).map((r) => [r.time, r.killsBy]), [[70, [1]]]);
      } finally {
        await store.close();
      }
    } finally {
      await busy.end().catch(() => {});
      await admin.end().catch(() => {});
    }
  });
});

describe('PostgreSQL 저장소: 연결 풀러와 시간 제한', { skip: skipAll }, () => {
  it('가짜 풀러는 statement_timeout 을 접속 매개변수로 보내는 연결을 거부한다 (아래 테스트가 헛돌지 않는다는 확인)', async () => {
    const pooler = await startPooler(targetOf());
    const client = new pg.Client({ connectionString: through(pooler.port), statement_timeout: 1000 });
    client.on('error', () => {});
    try {
      await assert.rejects(client.connect(), /unsupported startup parameter: statement_timeout/);
      assert.deepEqual(pooler.refused, ['statement_timeout']);
    } finally {
      await client.end().catch(() => {});
      await pooler.close();
    }
  });

  it('풀링 주소(PgBouncer) 뒤에서도 접속해서 테이블을 만들고 저장·조회하고, 아이템 통계도 더하고 읽는다', async () => {
    const pooler = await startPooler(targetOf());
    const store = await createPostgresStore(through(pooler.port));
    try {
      const season = newSeason();
      await store.save(run(season, { id: `pooled-${season}`, time: 77 }));
      await store.save(run(season, { id: `pooled-${season}`, time: 99 }));
      const rows = await store.load('solo', season, 5);
      assert.deepEqual(rows.map((r) => [r.id, r.time]), [[`pooled-${season}`, 77]]);
      await store.addStats(season, { runs: 1, since: 9, upgrades: { coffee: { offered: 2, picked: 1, autoPicked: 0, chest: 0, finalOwned: 1, finalLevelSum: 2 } } }, `batch-5-${season}`);
      assert.equal((await store.loadStats(season)).upgrades.coffee!.picked, 1);
      assert.ok((await store.seasons()).includes(season));
      assert.deepEqual(pooler.refused, [], '풀러가 거부하는 접속 매개변수를 보내지 않는다');
    } finally {
      await store.close();
      await pooler.close();
    }
  });

  it('DB 쪽 시간 제한은 그대로 걸린다: 잠긴 테이블에 막힌 저장은 제한 시간 뒤에 오류로 끝나고, 풀린 뒤에는 다시 된다', async () => {
    const store = await createPostgresStore(URL!, { statementTimeoutMs: 400 });
    const blocker = new pg.Client({ connectionString: URL! });
    await blocker.connect();
    try {
      const season = newSeason();
      await store.save(run(season, { time: 50 })); // 테이블을 만들어 둔다
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE leaderboard_runs IN ACCESS EXCLUSIVE MODE');
      const t0 = Date.now();
      await assert.rejects(store.save(run(season, { time: 60 })), (err: Error & { code?: string }) => err.code === '57014');
      assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0}ms`);
      await blocker.query('ROLLBACK');
      await store.save(run(season, { time: 70 }));
      assert.deepEqual((await store.load('solo', season, 5)).map((r) => r.time), [70, 50]);
    } finally {
      await blocker.end().catch(() => {});
      await store.close();
    }
  });
});

describe('PostgreSQL 저장소: DB 가 꺼지는 상황', { skip: skipCtl }, () => {
  it('시작할 때 DB 가 꺼져 있어도 만들어지고, load 는 reject 하다가 켜지면 성공한다', async () => {
    const crashes = watchCrashes();
    ctl('stop');
    let store;
    try {
      store = await createPostgresStore(URL!); // DB 없이도 즉시 돌아온다
      const season = newSeason();
      await assert.rejects(store.load('solo', season, 10));
      await assert.rejects(store.save(run(season)));
      ctl('start');
      const r = run(season);
      await store.save(r);
      assert.deepEqual(await store.load('solo', season, 10), [r]);
      await sleep(200);
      assert.deepEqual(crashes.events, []);
    } finally {
      ctl('start');
      await store?.close();
      crashes.stop();
    }
  });

  it('저장 사이에 DB 가 꺼졌다 켜져도 오류 없이 이어진다', async () => {
    const crashes = watchCrashes();
    const store = await createPostgresStore(URL!);
    try {
      const season = newSeason();
      const a = run(season, { time: 300 });
      await store.save(a); // 연결 하나가 풀에서 쉬는 상태가 된다
      ctl('stop'); // 쉬는 연결이 서버 쪽에서 끊긴다 → 풀의 'error' 이벤트
      await sleep(300);
      await assert.rejects(store.save(run(season)));
      ctl('start');
      const b = run(season, { time: 200 });
      await store.save(b);
      assert.deepEqual(await store.load('solo', season, 10), [a, b]);
      await sleep(300);
      assert.deepEqual(crashes.events, []);
    } finally {
      ctl('start');
      await store.close();
      crashes.stop();
    }
  });

  it('Leaderboard 는 DB 가 꺼져 있는 동안 기록하고, 켜지면 재시도로 저장한다', async () => {
    const season = newSeason();
    const lb = new Leaderboard(await createPostgresStore(URL!), season);
    await lb.init();
    ctl('stop');
    const rank = lb.record({ id: `down-${season}`, board: 'solo', names: ['가'], time: 120, kills: 1, level: 2, pausedSeconds: 0, endedAt: 1_700_000_000_000 });
    assert.equal(rank, 1); // 순위는 메모리에서 바로 나온다
    await sleep(500);
    assert.equal(lb.unsaved, 1);
    ctl('start');
    // 재시도는 1초 뒤
    for (let i = 0; i < 40 && lb.unsaved > 0; i++) await sleep(250);
    assert.equal(lb.unsaved, 0);
    await lb.close();
    const check = await createPostgresStore(URL!);
    try {
      assert.equal((await check.load('solo', season, 5)).length, 1);
    } finally {
      await check.close();
    }
  });
});
