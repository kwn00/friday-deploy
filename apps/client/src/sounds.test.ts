import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL_THEMES } from './themes';
import { DRUMS, MUSIC, SFX, noteHz, parsePattern, type Track } from './sounds';

test('sounds: 음 이름 → 주파수', () => {
  assert.equal(noteHz('A4'), 440);
  assert.ok(Math.abs(noteHz('C4') - 261.63) < 0.01);
  assert.ok(Math.abs(noteHz('A#4') - noteHz('Bb4')) < 1e-9);
  assert.throws(() => noteHz('H2'));
});

test('sounds: 악보 풀기 (길이, 쉼)', () => {
  assert.deepEqual(parsePattern('A4:2 -:2 C5'), {
    events: [
      { step: 0, len: 2, note: 'A4' },
      { step: 4, len: 1, note: 'C5' },
    ],
    steps: 5,
  });
  assert.throws(() => parsePattern('A4:0'));
});

test('sounds: 효과음은 짧고, 크기가 0~1 이고, 겹침 제한이 있다', () => {
  for (const [id, def] of Object.entries(SFX)) {
    assert.ok(def.tones.length > 0, id);
    assert.ok(def.voices >= 1 && def.voices <= 5, id);
    assert.ok(def.gap >= 30, `${id}: 너무 자주 울리면 뭉개진다`);
    for (const t of def.tones) {
      assert.ok(t.vol > 0 && t.vol <= 1, id);
      assert.ok(t.f > 0 && (t.to === undefined || t.to > 0), id);
      assert.ok((t.at ?? 0) + t.dur <= 1.5, `${id}: 1.5초 안에 끝나야 한다`);
    }
  }
});

test('sounds: 모든 곡(테마 곡 포함)은 lead · bass · drums 길이가 같고 마디(16칸)로 끝나며, 음 이름이 맞다', () => {
  const tracks: [string, Track][] = [...Object.entries(MUSIC), ...ALL_THEMES.flatMap((t) => Object.entries(t.music).map(([k, v]): [string, Track] => [`${t.id} ${k}`, v!]))];
  for (const [name, tr] of tracks) {
    const lead = parsePattern(tr.lead);
    const bass = parsePattern(tr.bass);
    const drums = parsePattern(tr.drums);
    assert.equal(lead.steps % 16, 0, `${name}: lead ${lead.steps}칸`);
    assert.equal(bass.steps, lead.steps, `${name}: bass`);
    assert.equal(drums.steps, lead.steps, `${name}: drums`);
    for (const e of [...lead.events, ...bass.events]) assert.ok(noteHz(e.note) > 30 && noteHz(e.note) < 4200, `${name}: ${e.note}`);
    for (const e of drums.events) assert.ok((DRUMS as readonly string[]).includes(e.note), `${name}: 드럼 ${e.note}`);
    assert.ok(tr.bpm >= 60 && tr.bpm <= 200, name);
    for (const v of [tr.leadVol, tr.bassVol, tr.drumVol]) assert.ok(v > 0 && v <= 1, name);
  }
});
