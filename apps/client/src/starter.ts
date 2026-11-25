/**
 * 시작 무기 고르기: 타이틀과 대기실의 무기 타일, 대기실 사람 목록의 아이콘에 쓰는 것.
 * 서버에는 목록의 번호(STARTER_WEAPONS 의 순서)만 보낸다. 실제로 무엇으로 시작하는지는 서버가 정한다 (허용 목록, 1단계).
 * 브라우저에는 무기 id 로 기억한다 (후보의 순서가 바뀌어도 고른 무기가 바뀌지 않게).
 *
 * 이 파일은 화면(DOM)을 쓰지 않는다 (단위 테스트에서 검사한다). 화면에 넣는 것은 main.ts 가 textContent 로 한다.
 */
import { DEFAULT_STARTER, STARTER_WEAPONS, UPGRADES, isStarter, starterIndex, type StarterId } from '@friday-deploy/shared';
import { evolveHint } from './evolve';

/** 브라우저 저장소(localStorage)의 키 */
export const STARTER_STORE = 'starter';

/**
 * 고르는 화면의 짧은 설명: 무기의 성격을 쉬운 말로 한 줄에 (320px 화면에서도 이름과 함께 한 줄에 들어가게 짧게).
 * 자세한 설명(UPGRADES 의 desc)은 타일의 title 로 보여 준다. 후보를 늘리면 여기도 채워야 한다 (빠지면 타입 검사가 막는다)
 */
const BLURB: Record<StarterId, string> = {
  console_log: '가장 가까운 버그를 쏜다',
  rollback: '부메랑처럼 오가며 꿰뚫는다',
  ai_agent: '버그 하나에게 몰아 쏜다',
  firewall: '내 둘레를 태운다. 버티기 좋다',
};

export interface StarterOption {
  id: StarterId;
  /** 통신 번호 (hello.starter, starter 메시지) */
  index: number;
  icon: string;
  name: string;
  /** 짧은 설명 (고른 무기 아래 한 줄) */
  blurb: string;
  /** 자세한 설명 (선택지 카드와 같은 문구) */
  desc: string;
  /** 진화 안내 ("✨ 진화: 최대 단계 + 🧪 테스트 커버리지 → 🐞 디버거"). 진화가 없으면 null */
  evolve: string | null;
}

/** 고를 수 있는 시작 무기들 (통신 번호 순서) */
export function starterOptions(): StarterOption[] {
  return STARTER_WEAPONS.map((id) => {
    const def = UPGRADES[id];
    return { id, index: starterIndex(id), icon: def.icon, name: def.name, blurb: BLURB[id], desc: def.desc, evolve: evolveHint(id, {}) };
  });
}

/** 타일에 마우스를 올렸을 때의 안내: 이름, 자세한 설명, (있으면) 진화 */
export function starterTip(o: StarterOption): string {
  return [o.name, o.desc, o.evolve].filter(Boolean).join('\n');
}

/** 브라우저가 기억한 값 → 시작 무기. 없거나 모르는 값(후보에서 빠진 무기, 손으로 고친 값)이면 기본 무기 */
export function readStarter(raw: string | null | undefined): StarterId {
  return isStarter(raw) ? raw : DEFAULT_STARTER;
}

/** 고른 무기를 알려 주는 한 줄: "🖨️ console.log() · 가장 가까운 버그를 쏜다" */
export function starterLine(id: StarterId): string {
  const def = UPGRADES[id];
  return `${def.icon} ${def.name} · ${BLURB[id]}`;
}

/**
 * 서버가 사람 목록(roster)에 실어 준 시작 무기 → 아이콘과 이름. 지금 고를 수 있는 무기가 아니면 null
 * (서버에서 온 값이라도 모양을 확인하고 쓴다. 아이콘과 이름은 우리 목록의 것만 화면에 넣는다)
 */
export function rosterStarter(v: unknown): { id: StarterId; icon: string; name: string } | null {
  if (!isStarter(v)) return null;
  return { id: v, icon: UPGRADES[v].icon, name: UPGRADES[v].name };
}
