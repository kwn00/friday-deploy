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

  it('정리: 순위표당 1000건을 넘으면 맨 아래만 지우고 상위 1000건은 그대로다', async () => {
    const store = await createPostgresStore(URL!);
    try {
      const season = newSeason();
      const runs = randomRuns(season, 1100); // 50번째 저장마다 정리가 돈다
      for (let i = 0; i < runs.length; i += 50) await Promise.all(runs.slice(i, i + 50).map((r) => store.save(r)));
      await sleep(500);
      const got = await store.load('solo', season, 5000);
      assert.ok(got.length >= 1000 && got.length <= 1100, `남은 기록 ${got.length}건`);
      assert.ok(got.length < 1100, '정리가 아무것도 지우지 않았다');
      assert.deepEqual(got, [...runs].sort(compareRuns).slice(0, got.length));
    } finally {
      await store.close();
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

  it('풀링 주소(PgBouncer) 뒤에서도 접속해서 테이블을 만들고 저장·조회·정리한다', async () => {
    const pooler = await startPooler(targetOf());
    const store = await createPostgresStore(through(pooler.port));
    try {
      const season = newSeason();
      await store.save(run(season, { id: `pooled-${season}`, time: 77 }));
      await store.save(run(season, { id: `pooled-${season}`, time: 99 }));
      const rows = await store.load('solo', season, 5);
      assert.deepEqual(rows.map((r) => [r.id, r.time]), [[`pooled-${season}`, 77]]);
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
