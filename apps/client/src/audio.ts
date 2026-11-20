/**
 * 소리 연주기 (Web Audio). 악보는 sounds.ts, 언제 낼지는 sound-cues.ts 와 main.ts 가 정한다.
 *
 * - 브라우저는 사용자가 화면을 한 번 누르기 전에는 소리를 내지 못하게 한다. 그래서 처음 누를 때 unlock() 으로 깨운다.
 * - 화면을 떠나면(다른 탭, 앱 전환) 멈추고, 돌아오면 이어서 낸다.
 * - 효과음과 음악은 따로 켜고 끈다. 같은 소리가 너무 자주·많이 겹치지 않게 Sfx 의 gap · voices 로 거른다.
 */
import { MUSIC, SFX, noteHz, parsePattern, type Drum, type LeadVoice, type MusicId, type NoteEvent, type SfxId, type Tone, type Track } from './sounds';
import type { Cue } from './sound-cues';
import type { Theme } from './themes';
import type { ThemeTarget } from './apply-theme';

/** 미리 풀어 둔 곡: 칸 번호 → 그 칸에서 시작하는 음 */
interface Song {
  track: Track;
  steps: number;
  lead: Map<number, NoteEvent>;
  bass: Map<number, NoteEvent>;
  drums: Map<number, NoteEvent>;
}

function compile(track: Track): Song {
  const index = (src: string): [Map<number, NoteEvent>, number] => {
    const { events, steps } = parsePattern(src);
    return [new Map(events.map((e) => [e.step, e])), steps];
  };
  const [lead, steps] = index(track.lead);
  const [bass] = index(track.bass);
  const [drums] = index(track.drums);
  return { track, steps, lead, bass, drums };
}

const MASTER = 1;
const SFX_BUS = 0.9;
const MUSIC_BUS = 0.5;
/** 메뉴·선택창이 열려 있을 때 음악 크기 */
const DUCKED = 0.35;
/** 얼마나 앞서 음을 예약하는지 (초). 탭이 바빠도 끊기지 않게 */
const LOOKAHEAD = 0.15;

export class Sound implements ThemeTarget {
  private ctx: AudioContext | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private sfxOn = true;
  private musicOn = true;
  private ducked = false;
  /** 소리마다: 마지막으로 낸 시각(ms), 울리고 있는 것들이 끝나는 시각(초, ctx 기준) */
  private last = new Map<SfxId, number>();
  private playing = new Map<SfxId, number[]>();
  /** 경험치를 연달아 먹으면 음이 올라간다 */
  private gemStreak = 0;
  private gemAt = 0;
  private music: Partial<Record<MusicId, Track>> = {};
  private want: MusicId | null = null;
  private song: Song | null = null;
  private songId: MusicId | null = null;
  private step = 0;
  private nextAt = 0;
  private timer = 0;

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  /** 사용자가 화면을 눌렀을 때 부른다 (그 전에는 소리를 낼 수 없다). 여러 번 불러도 된다 */
  unlock(): void {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const comp = ctx.createDynamicsCompressor();
      const master = ctx.createGain();
      master.gain.value = MASTER;
      comp.connect(master).connect(ctx.destination);
      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = this.sfxOn ? SFX_BUS : 0;
      this.sfxBus.connect(comp);
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = this.musicGain();
      this.musicBus.connect(comp);
      const len = ctx.sampleRate;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.ctx = ctx;
      this.timer = window.setInterval(() => this.schedule(), 25);
    }
    if (this.ctx.state !== 'running' && !document.hidden) void this.ctx.resume();
  }

  setTheme(theme: Theme): void {
    this.music = theme.music;
    // 같은 곡 이름이라도 테마가 바뀌면 다른 곡일 수 있다: 처음부터 다시
    this.songId = null;
  }

  setSfx(on: boolean): void {
    this.sfxOn = on;
    this.sfxBus?.gain.setTargetAtTime(on ? SFX_BUS : 0, this.ctx!.currentTime, 0.02);
  }

  setMusicOn(on: boolean): void {
    this.musicOn = on;
    this.applyMusicGain();
  }

  /** 메뉴·선택창이 열려 있는 동안 음악을 줄인다 */
  duck(on: boolean): void {
    if (on === this.ducked) return;
    this.ducked = on;
    this.applyMusicGain();
  }

  /** 틀 곡 (null 이면 끈다). 같은 곡이면 이어서 튼다 */
  playMusic(id: MusicId | null): void {
    this.want = id;
  }

  private musicGain(): number {
    return this.musicOn ? MUSIC_BUS * (this.ducked ? DUCKED : 1) : 0;
  }

  private applyMusicGain(): void {
    if (this.ctx && this.musicBus) this.musicBus.gain.setTargetAtTime(this.musicGain(), this.ctx.currentTime, 0.1);
  }

  /** 화면 장면이 바뀔 때 생긴 소리들 (sound-cues.ts) */
  cue(c: Cue): void {
    if (c.id === 'gem') {
      const now = performance.now();
      this.gemStreak = now - this.gemAt < 450 ? Math.min(this.gemStreak + 1, 12) : 0;
      this.gemAt = now;
      this.play('gem', 2 ** (this.gemStreak / 12));
      return;
    }
    // 여러 마리가 한꺼번에 맞거나 쓰러지면 조금 크게 (한 번만 낸다)
    this.play(c.id, 1, c.n > 1 ? Math.min(1.6, 1 + Math.log2(c.n) * 0.2) : 1);
  }

  play(id: SfxId, pitch = 1, gain = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxOn || ctx.state !== 'running' || !this.sfxBus) return;
    const def = SFX[id];
    const now = performance.now();
    if (now - (this.last.get(id) ?? -Infinity) < def.gap) return;
    const t = ctx.currentTime;
    const busy = (this.playing.get(id) ?? []).filter((end) => end > t);
    if (busy.length >= def.voices) return;
    this.last.set(id, now);
    let end = t;
    for (const tone of def.tones) end = Math.max(end, this.tone(tone, t, pitch, gain, this.sfxBus));
    busy.push(end);
    this.playing.set(id, busy);
  }

  /** 음 하나. 끝나는 시각(ctx 기준 초)을 돌려준다 */
  private tone(tone: Tone, t0: number, pitch: number, gain: number, bus: AudioNode): number {
    const ctx = this.ctx!;
    const t = t0 + (tone.at ?? 0);
    const end = t + tone.dur;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, tone.vol * gain), t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    env.connect(bus);
    let src: AudioScheduledSourceNode;
    if (tone.wave === 'noise') {
      const n = ctx.createBufferSource();
      n.buffer = this.noise;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = tone.f;
      filter.Q.value = 0.8;
      n.connect(filter).connect(env);
      src = n;
    } else {
      const osc = ctx.createOscillator();
      osc.type = tone.wave;
      osc.frequency.setValueAtTime(tone.f * pitch, t);
      if (tone.to) osc.frequency.exponentialRampToValueAtTime(tone.to * pitch, end);
      osc.connect(env);
      src = osc;
    }
    src.start(t);
    src.stop(end + 0.02);
    src.onended = () => env.disconnect();
    return end;
  }

  /* ───────────── 음악 ───────────── */

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.musicBus) return;
    // 음악을 꺼 두면 음을 만들지 않는다 (소리만 줄이는 것이 아니라). 다시 켜면 곡을 처음부터
    if (!this.musicOn) {
      this.songId = null;
      return;
    }
    if (this.want !== this.songId) {
      this.songId = this.want;
      const track = this.want ? (this.music[this.want] ?? MUSIC[this.want]) : null;
      this.song = track ? compile(track) : null;
      this.step = 0;
      this.nextAt = ctx.currentTime + 0.05;
    }
    const song = this.song;
    if (!song) return;
    // 멈춰 있다 돌아왔으면(탭 전환 등) 밀린 음을 한꺼번에 내지 않고 지금부터 이어 간다
    if (this.nextAt < ctx.currentTime - 0.05) this.nextAt = ctx.currentTime + 0.05;
    const stepLen = 60 / song.track.bpm / 4;
    while (this.nextAt < ctx.currentTime + LOOKAHEAD) {
      const s = this.step % song.steps;
      const tr = song.track;
      const lead = song.lead.get(s);
      if (lead) this.lead(tr.leadVoice, noteHz(lead.note), this.nextAt, lead.len * stepLen, tr.leadVol);
      const bass = song.bass.get(s);
      if (bass) this.tone({ wave: 'triangle', f: noteHz(bass.note), dur: bass.len * stepLen * 0.9, vol: tr.bassVol }, this.nextAt, 1, 1, this.musicBus);
      const drum = song.drums.get(s);
      if (drum) this.drum(drum.note as Drum, this.nextAt, tr.drumVol);
      this.step++;
      this.nextAt += stepLen;
    }
  }

  private lead(voice: LeadVoice, f: number, t: number, len: number, vol: number): void {
    const bus = this.musicBus!;
    if (voice === 'bell') {
      // 종소리: 맑은 음 + 높은 배음, 길게 울리며 사라진다
      this.tone({ wave: 'sine', f, dur: Math.max(0.5, len), vol }, t, 1, 1, bus);
      this.tone({ wave: 'sine', f: f * 3.01, dur: 0.25, vol: vol * 0.35 }, t, 1, 1, bus);
    } else {
      this.tone({ wave: voice, f, dur: len * 0.85, vol }, t, 1, 1, bus);
    }
  }

  private drum(d: Drum, t: number, vol: number): void {
    const bus = this.musicBus!;
    if (d === 'k') this.tone({ wave: 'sine', f: 150, to: 45, dur: 0.12, vol: 0.5 * vol }, t, 1, 1, bus);
    else if (d === 's') this.tone({ wave: 'noise', f: 1800, dur: 0.1, vol: 0.25 * vol }, t, 1, 1, bus);
    else if (d === 'h') this.tone({ wave: 'noise', f: 7000, dur: 0.03, vol: 0.12 * vol }, t, 1, 1, bus);
    else {
      // 방울: 높은 잡음을 짧게 두 번
      this.tone({ wave: 'noise', f: 8000, dur: 0.05, vol: 0.16 * vol }, t, 1, 1, bus);
      this.tone({ wave: 'noise', f: 9500, at: 0.04, dur: 0.06, vol: 0.12 * vol }, t, 1, 1, bus);
    }
  }
}

