import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { APP_VERSION, RELEASES, compareVersions, unseenReleases } from './index';

const ROOT = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), 'utf8');

test('버전: 현재 버전은 릴리즈 목록의 맨 위이고, 모든 package.json 과 package-lock.json 이 같은 버전이다', () => {
  assert.equal(APP_VERSION, RELEASES[0]!.version);
  for (const path of ['package.json', 'apps/client/package.json', 'apps/server/package.json', 'packages/shared/package.json']) {
    assert.equal((JSON.parse(read(path)) as { version: string }).version, APP_VERSION, path);
  }
  const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version?: string }> };
  assert.equal(lock.version, APP_VERSION, 'package-lock.json');
  for (const path of ['', 'apps/client', 'apps/server', 'packages/shared']) assert.equal(lock.packages[path]!.version, APP_VERSION, `package-lock.json packages["${path}"]`);
});

test('릴리즈 목록: 최신순이고 버전이 겹치지 않으며, 버전마다 GitHub 릴리즈 본문 파일이 있다', () => {
  for (const [i, r] of RELEASES.entries()) {
    assert.match(r.version, /^\d+\.\d+\.\d+$/, r.version);
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, `${r.version} 날짜`);
    assert.ok(!Number.isNaN(Date.parse(r.date)), `${r.version} 날짜`);
    if (i > 0) assert.ok(compareVersions(RELEASES[i - 1]!.version, r.version) > 0, `${RELEASES[i - 1]!.version} 다음에 ${r.version}`);
    const file = `docs/releases/${r.version}.md`;
    assert.ok(existsSync(new URL(file, ROOT)), `${file} 이 있어야 한다 (GitHub 릴리즈의 본문)`);
    assert.ok(read(file).trim().length > 0, `${file} 이 비어 있다`);
    // 첫 줄이 GitHub 릴리즈의 제목이 된다. 다른 버전의 파일을 복사하고 제목을 고치지 않은 경우를 잡는다.
    const first = read(file).split('\n')[0]!;
    assert.ok(first === `# v${r.version}` || first.startsWith(`# v${r.version} `), `${file} 의 첫 줄은 "# v${r.version} — 한 줄 요약" 이어야 한다 (지금: "${first}")`);
  }
});

test('게임 안 릴리즈노트: 짧고 쉽게 (한 버전에 1~5줄, 한 줄 70자 이하, 제목 30자 이하)', () => {
  for (const r of RELEASES) {
    assert.ok(r.title.trim().length > 0 && r.title.length <= 30, `${r.version} 제목: ${r.title}`);
    assert.ok(r.items.length >= 1 && r.items.length <= 5, `${r.version}: ${r.items.length}줄`);
    for (const item of r.items) assert.ok(item.trim().length > 0 && item.length <= 70, `${r.version}: "${item}" (${item.length}자)`);
  }
});

test('버전 비교', () => {
  assert.ok(compareVersions('0.0.2', '0.0.1') > 0);
  assert.ok(compareVersions('0.1.0', '0.0.9') > 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.ok(compareVersions('0.0.10', '0.0.9') > 0, '숫자로 비교한다 (문자열 비교가 아니다)');
  assert.equal(compareVersions('0.0.1', '0.0.1'), 0);
  assert.ok(compareVersions('이상한값', '0.0.1') < 0);
});

test('자동으로 보여줄 릴리즈노트: 처음 보는 버전일 때만, 같은 버전으로 다시 오면 없다', () => {
  // 처음 온 브라우저 / 값이 이상한 경우: 현재 버전의 것 하나
  for (const seen of [null, undefined, '', 'v0.0.1', '1.2', '0.0.1; DROP', '<script>']) {
    assert.deepEqual(unseenReleases(seen).map((r) => r.version), [APP_VERSION], String(seen));
  }
  // 같은 버전을 이미 봤다 (또는 더 새 버전을 봤다: 배포를 되돌린 경우)
  assert.deepEqual(unseenReleases(APP_VERSION), []);
  assert.deepEqual(unseenReleases('999.0.0'), []);
  // 옛 버전을 본 브라우저: 그 뒤에 나온 것만, 최신순, 최대 3개
  const older = unseenReleases('0.0.0');
  assert.ok(older.length >= 1 && older.length <= 3);
  assert.equal(older[0]!.version, APP_VERSION);
  for (const r of older) assert.ok(compareVersions(r.version, '0.0.0') > 0);
  assert.equal(unseenReleases('0.0.0', 1).length, 1);
});
