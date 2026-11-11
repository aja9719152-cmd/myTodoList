'use strict';

/* =============================================================================
 * My Tasks — 할 일 관리 앱
 *
 * 구조 개요
 * ---------
 * - 상태(state)가 유일한 진실의 원천(single source of truth)이다.
 *   모든 변경은 "상태 변경 → saveTodos()(디바운스 저장) → render()" 순서를 따른다.
 * - render()는 화면을 상태로부터 다시 계산하지만, DOM은 통째로 다시 만들지 않는다.
 *   항목별로 만든 <li>를 nodeCache에 보관해 두고, 내용이 바뀐 항목만 새로 만들며
 *   순서가 달라진 노드만 옮긴다(키 기반 재조정). 100개 이상에서도 부드럽게 동작하고
 *   포커스도 유지된다.
 * - 삭제·가져오기처럼 되돌릴 수 있는 작업은 undoStack에 "되돌리는 함수"를 쌓는다.
 *
 * 섹션
 *   1. 상수            2. DOM 참조         3. 상태
 *   4. 유틸리티        5. 저장소           6. 필터·정렬
 * 6-1. 키워드 자동 분류
 *   7. 할 일 조작      8. 되돌리기(Undo)    9. 내보내기·가져오기
 *  10. 테마           11. 피드백(토스트·알림·대화상자·애니메이션)
 *  12. 렌더링         13. 드래그 앤 드롭   14. 이벤트 연결   15. 초기화
 * ========================================================================== */

// =============================================================================
// 1. 상수
// =============================================================================

/** localStorage 키. theme 키는 index.html <head>의 인라인 스크립트도 직접 읽는다. */
const STORAGE_KEYS = Object.freeze({
  todos: 'todos',
  filter: 'todoFilter',
  sort: 'todoSort',
  theme: 'todoTheme',
  autoCategory: 'todoAutoCategory', // 'on' | 'off'
  corruptedBackup: 'todos_corrupted_backup',
});

/** 카테고리 키 → 표시 이름. 객체 순서가 곧 "카테고리순" 정렬 순서다. */
const CATEGORIES = Object.freeze({
  work: '업무',
  personal: '개인',
  study: '공부',
});
const DEFAULT_CATEGORY = 'personal';

/** 필터 목록. 순서가 Alt+1~4 단축키 순서다. */
const FILTERS = Object.freeze(['all', ...Object.keys(CATEGORIES)]);

/** 정렬 방식 → 표시 이름. 'status'가 기본값(미완료 먼저, 완료는 아래로). */
const SORTS = Object.freeze({
  status: '완료 상태순',
  manual: '직접 정렬',
  newest: '최신순',
  oldest: '오래된순',
  category: '카테고리순',
});
const DEFAULT_SORT = 'status';

const MAX_TEXT_LENGTH = 200; // 할 일 한 개의 최대 글자 수 (index.html의 maxlength와 같음)
const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 가져오기 파일 최대 크기 5MB
const MAX_UNDO = 20; // 되돌리기 기록 최대 개수

const SAVE_DEBOUNCE_MS = 300; // 연속 변경 시 마지막 변경 후 300ms 뒤에 한 번만 저장
const SEARCH_DEBOUNCE_MS = 150; // 타이핑이 멈춘 뒤 150ms 후 검색
const ANIMATION_FALLBACK_MS = 400; // CSS 애니메이션보다 약간 길게: animationend가 안 와도 진행
const THEME_TRANSITION_MS = 400;
const TOAST_MS = 5000; // "되돌리기"를 누를 시간을 고려해 5초
const MAX_TOASTS = 3;
const DRAG_EDGE_PX = 60; // 드래그 중 화면 가장자리에서 이 거리 안이면 자동 스크롤
const DRAG_SCROLL_STEP = 12;

/** 내보내기 파일 형식 식별자. 가져올 때 형식 확인에 사용한다. */
const EXPORT_FORMAT = 'my-tasks';
const EXPORT_VERSION = 1;

/**
 * 자동 카테고리 분류용 키워드.
 * - 한국어는 부분 문자열로 찾으므로 한 글자 키워드는 넣지 않는다
 *   (예: '책'은 '책상', '약'은 '계약'·'요약'에도 걸린다).
 * - 여러 카테고리에 걸칠 수 있는 말(발표, 세미나, 면접, 예약 등)은 일부러 뺐다.
 * - 짧은 키워드를 포함하는 더 긴 키워드는 긴 쪽이 우선한다
 *   (예: '머신러닝'(공부)이 '러닝'(개인)보다, '보고서'가 다른 짧은 말보다 먼저).
 * - 영어(ASCII) 키워드는 단어 경계로 찾는다 ('pr'이 'print'에 걸리지 않게).
 */
const CATEGORY_KEYWORDS = Object.freeze({
  work: [
    '회의', '회의실', '미팅', '보고서', '보고하기', '업무', '출근', '퇴근', '야근', '메일', '이메일',
    '기획', '기획서', '제안서', '결재', '품의', '프로젝트', '마감', '납기', '고객', '거래처',
    '클라이언트', '계약', '견적', '팀장', '부장', '과장', '상사', '동료', '회사', '사무실', '출장',
    '매출', '예산', '배포', '코드 리뷰',
    'meeting', 'report', 'email', 'deadline', 'client', 'project', 'deploy', 'pr',
  ],
  personal: [
    '운동', '헬스', '요가', '필라테스', '산책', '조깅', '러닝', '등산', '수영', '장보기', '장 보기',
    '마트', '쇼핑', '청소', '빨래', '설거지', '분리수거', '요리', '집안일', '병원', '치과', '약국',
    '약 먹기', '영양제', '은행', '공과금', '월세', '관리비', '생일', '선물', '기념일', '결혼식',
    '가족', '부모님', '엄마', '아빠', '친구', '약속', '데이트', '여행', '미용실', '택배', '세탁소',
    '이사', '세차', '주유', '강아지', '고양이', '영화',
    'gym', 'workout', 'groceries', 'laundry', 'birthday', 'dentist',
  ],
  study: [
    '공부', '강의', '인강', '수업', '과제', '숙제', '시험', '중간고사', '기말고사', '복습', '예습',
    '독서', '책 읽기', '책읽기', '논문', '자격증', '토익', '토플', '오픽', '영어', '단어', '암기',
    '문제집', '학원', '과외', '스터디', '튜토리얼', '학습', '레포트', '리포트', '알고리즘',
    '코딩테스트', '머신러닝', '딥러닝',
    'study', 'lecture', 'homework', 'exam', 'course',
  ],
});

/** 오늘의 격언. 날짜마다 하나가 정해지고 🔄 버튼으로 무작위로 바꿀 수 있다. */
const QUOTES = Object.freeze([
  { text: '천 리 길도 한 걸음부터.', author: '속담' },
  { text: '시작이 반이다.', author: '속담' },
  { text: '티끌 모아 태산.', author: '속담' },
  { text: '낙숫물이 댓돌을 뚫는다.', author: '속담' },
  { text: '급할수록 돌아가라.', author: '속담' },
  { text: '늦었다고 생각할 때가 가장 빠를 때다.', author: '격언' },
  { text: '로마는 하루아침에 이루어지지 않았다.', author: '서양 속담' },
  { text: '구르는 돌에는 이끼가 끼지 않는다.', author: '서양 속담' },
  { text: '일찍 일어나는 새가 벌레를 잡는다.', author: '서양 속담' },
  { text: '아는 것이 힘이다.', author: '프랜시스 베이컨' },
  { text: '배움에는 왕도가 없다.', author: '유클리드' },
  { text: '천재는 1%의 영감과 99%의 노력으로 이루어진다.', author: '토머스 에디슨' },
  { text: '오늘 할 수 있는 일을 내일로 미루지 마라.', author: '벤저민 프랭클린' },
  { text: '작은 기회가 종종 위대한 일의 시작이 된다.', author: '데모스테네스' },
  { text: '우리가 반복적으로 하는 행동이 곧 우리 자신이다.', author: '윌 듀런트' },
]);

// =============================================================================
// 2. DOM 참조
// =============================================================================

/**
 * id로 요소를 찾고, 없으면 원인을 알 수 있는 오류를 던진다.
 * index.html과 script.js가 어긋났을 때 엉뚱한 곳에서 null 오류가 나는 것을 막는다.
 */
function requireElement(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`필수 요소 #${id}를 index.html에서 찾을 수 없습니다.`);
  return el;
}

const dom = {
  form: requireElement('todo-form'),
  input: requireElement('todo-input'),
  categorySelect: requireElement('todo-category'),
  filterBar: requireElement('filter-bar'),
  searchInput: requireElement('search-input'),
  sortSelect: requireElement('sort-select'),
  list: requireElement('todo-list'),
  empty: requireElement('todo-empty'),
  badge: requireElement('remaining-badge'),
  themeToggle: requireElement('theme-toggle'),
  undoBtn: requireElement('undo-btn'),
  clearCompletedBtn: requireElement('clear-completed'),
  exportBtn: requireElement('export-btn'),
  importBtn: requireElement('import-btn'),
  importFile: requireElement('import-file'),
  toastContainer: requireElement('toast-container'),
  srStatus: requireElement('sr-status'),
  confirmDialog: requireElement('confirm-dialog'),
  confirmTitle: requireElement('confirm-title'),
  confirmMessage: requireElement('confirm-message'),
  confirmOk: requireElement('confirm-ok'),
  importDialog: requireElement('import-dialog'),
  importSummary: requireElement('import-summary'),
  importOptions: requireElement('import-options'),
  importBackup: requireElement('import-backup'),
  autoCategoryToggle: requireElement('auto-category-toggle'),
  autoCategoryHint: requireElement('auto-category-hint'),
  quoteText: requireElement('quote-text'),
  quoteAuthor: requireElement('quote-author'),
  quoteNext: requireElement('quote-next'),
  cheer: requireElement('cheer-message'),
  statsOverallText: requireElement('stats-overall-text'),
  statsOverallProgress: requireElement('stats-overall-progress'),
  statsOverallBar: requireElement('stats-overall-bar'),
  statsToday: requireElement('stats-today'),
};

/** 카테고리별 대시보드 요소. 매 렌더마다 querySelector하지 않도록 미리 찾아 둔다. */
const categoryStatEls = Object.fromEntries(
  Object.keys(CATEGORIES).map((category) => {
    const bar = document.querySelector(`[data-bar="${category}"]`);
    return [category, {
      count: document.querySelector(`[data-count="${category}"]`),
      bar,
      progress: bar?.closest('[role="progressbar"]') ?? null,
    }];
  }),
);

// =============================================================================
// 3. 상태
// =============================================================================

/**
 * 할 일 하나의 모양.
 * @typedef {{ id: string, text: string, completed: boolean, createdAt: string, category: string }} Todo
 */

// --- 저장되는 상태 ---
/** @type {Todo[]} 배열 순서 = "직접 정렬" 순서 */
let todos = [];
let currentFilter = 'all';
let sortMode = DEFAULT_SORT;

// --- 화면 전용 상태 (저장하지 않음) ---
let searchQuery = ''; // 비교용: 소문자로 정규화한 검색어
let searchRaw = ''; // 표시용: 사용자가 입력한 그대로 (앞뒤 공백 제거)
let editingId = null; // 인라인 편집 중인 항목 id
let quoteIndex = 0;
let lastRemaining = null; // 배지 숫자가 바뀌었는지 감지하는 용도
let themeTransitionTimer = 0;

// --- 자동 카테고리 분류 상태 ---
let autoCategoryEnabled = true; // 저장됨 (STORAGE_KEYS.autoCategory)
let categoryTouched = false; // 이번 입력에서 사용자가 드롭다운을 직접 골랐는지 (추가하면 초기화)
let baseCategory = DEFAULT_CATEGORY; // 키워드가 없을 때 돌아갈 카테고리 = 사용자가 마지막으로 직접 고른 값
let lastAutoCategory = null; // 자동 선택이 바뀌었을 때만 강조 효과를 주기 위해 기억

/** 다음 render에서 한 번만 적용할 등장 애니메이션: id → 'fade-in' | 'slide-in' | 'flash' */
const entryAnimations = new Map();

/** 키 기반 재조정용 캐시: id → { el: <li>, sig: 내용 서명 } */
const nodeCache = new Map();

/** 되돌리기 기록: { label, undo } 목록. 마지막이 가장 최근 작업 */
const undoStack = [];

/** 초기화 중 발견한 문제. 화면이 준비된 뒤 토스트로 알린다. */
const startupWarnings = [];

/** 진행 중인 드래그 정보 (없으면 null) */
let drag = null;
let dragFrame = 0;

// =============================================================================
// 4. 유틸리티
// =============================================================================

/**
 * 마지막 호출 후 wait(ms) 동안 다시 호출되지 않으면 fn을 실행한다.
 * flush()로 대기 중인 호출을 즉시 실행하고, pending()으로 대기 여부를 확인할 수 있다.
 */
function debounce(fn, wait) {
  let timer = null;
  let lastArgs = [];
  function run() {
    timer = null;
    fn(...lastArgs);
  }
  function debounced(...args) {
    lastArgs = args;
    clearTimeout(timer);
    timer = setTimeout(run, wait);
  }
  debounced.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      run();
    }
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  debounced.pending = () => timer !== null;
  return debounced;
}

/** 'toString' 같은 상속 속성에 속지 않도록 hasOwn으로 확인 */
function isCategory(value) {
  return typeof value === 'string' && Object.hasOwn(CATEGORIES, value);
}

/** 중복 비교용: 앞뒤 공백 제거, 연속 공백 하나로, 소문자 */
function normalizeText(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // randomUUID가 없는 환경(구형 브라우저, http의 일부 환경) 대비
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function truncate(text, max = 20) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function percent(done, total) {
  return total === 0 ? 0 : Math.round((done / total) * 100);
}

/** ISO 문자열을 밀리초로. 잘못된 날짜는 0으로 취급해 정렬이 깨지지 않게 한다. */
function timeOf(todo) {
  const t = Date.parse(todo.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

/** 로컬 날짜를 YYYY-MM-DD로 (파일 이름용) */
function formatDateForFile(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "방금 전 / N분 전 / N시간 전 / N일 전", 7일이 지나면 날짜 */
function formatRelativeTime(isoString) {
  const time = Date.parse(isoString);
  if (Number.isNaN(time)) return '';
  // 시계가 어긋나 미래 시각인 경우도 "방금 전"으로 처리
  const diffSec = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (diffSec < 60) return '방금 전';
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day}일 전`;
  return new Date(time).toLocaleDateString('ko-KR');
}

/** 텍스트를 입력하는 요소인지 (이 경우 Ctrl+Z는 브라우저 기본 동작에 맡김) */
function isTextField(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes(el.type);
}

function isAnyDialogOpen() {
  return dom.confirmDialog.open || dom.importDialog.open;
}

// =============================================================================
// 5. 저장소 (localStorage)
// =============================================================================

/** localStorage는 사생활 보호 모드나 정책에 따라 접근만 해도 예외가 날 수 있다. */
function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    console.warn(`localStorage 읽기 실패 (${key}):`, err);
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    // 대표적으로 QuotaExceededError (용량 초과)
    console.error(`localStorage 저장 실패 (${key}):`, err);
    return false;
  }
}

/**
 * 외부에서 들어온 값(저장소, 가져온 파일)을 안전한 Todo로 바꾼다.
 * 필수 값(text)이 없으면 null. 나머지 필드는 가능한 한 보정한다.
 * @returns {Todo | null}
 */
function sanitizeTodo(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, MAX_TEXT_LENGTH) : '';
  if (!text) return null;

  let id = '';
  if (typeof raw.id === 'string') id = raw.id.trim();
  else if (typeof raw.id === 'number' && Number.isFinite(raw.id)) id = String(raw.id);

  const created = typeof raw.createdAt === 'string' || typeof raw.createdAt === 'number'
    ? new Date(raw.createdAt)
    : null;

  return {
    id: id || generateId(),
    text,
    completed: raw.completed === true,
    createdAt: created && !Number.isNaN(created.getTime()) ? created.toISOString() : new Date().toISOString(),
    // 이전 버전 데이터처럼 category가 없거나 잘못되었으면 기본 카테고리로
    category: isCategory(raw.category) ? raw.category : DEFAULT_CATEGORY,
  };
}

/**
 * 배열 전체를 정리한다. 잘못된 항목은 버리고, 같은 id가 겹치면 새 id를 준다.
 * @returns {{ items: Todo[], invalid: number }}
 */
function sanitizeTodoList(rawList) {
  const items = [];
  const seenIds = new Set();
  let invalid = 0;
  for (const raw of rawList) {
    const todo = sanitizeTodo(raw);
    if (!todo) {
      invalid += 1;
      continue;
    }
    if (seenIds.has(todo.id)) todo.id = generateId();
    seenIds.add(todo.id);
    items.push(todo);
  }
  return { items, invalid };
}

/** 손상된 원본을 지우지 않고 별도 키에 보관한다 (사용자가 복구할 여지를 남김). */
function backupCorruptedData(raw) {
  writeStorage(STORAGE_KEYS.corruptedBackup, raw);
}

/** @returns {Todo[]} */
function loadTodos() {
  const raw = readStorage(STORAGE_KEYS.todos);
  if (raw === null) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }

  if (!Array.isArray(parsed)) {
    backupCorruptedData(raw);
    startupWarnings.push(
      `저장된 데이터를 읽지 못해 빈 목록으로 시작합니다. 원본은 브라우저 저장소의 '${STORAGE_KEYS.corruptedBackup}'에 보관했습니다.`,
    );
    return [];
  }

  const { items, invalid } = sanitizeTodoList(parsed);
  if (invalid > 0) {
    backupCorruptedData(raw);
    startupWarnings.push(`저장된 항목 중 손상된 ${invalid}개를 제외했습니다.`);
  }
  return items;
}

/** 저장할 수 있는 값 목록 중 하나를 읽고, 아니면 기본값 */
function loadChoice(key, allowed, fallback) {
  const saved = readStorage(key);
  return allowed.includes(saved) ? saved : fallback;
}

let saveFailing = false; // 실패 알림을 매번 띄우지 않도록 상태 전환 시에만 알림

/** 실제 저장. 직접 부르지 말고 saveTodos()(디바운스)를 사용한다. */
function persistTodos() {
  const ok = writeStorage(STORAGE_KEYS.todos, JSON.stringify(todos));
  if (!ok && !saveFailing) {
    showToast('브라우저에 저장하지 못했습니다. 저장 공간이 부족하거나 차단되어 있을 수 있습니다. 내보내기로 백업해 두세요.', {
      type: 'error',
      duration: 8000,
    });
  } else if (ok && saveFailing) {
    showToast('저장이 다시 정상적으로 동작합니다.');
  }
  saveFailing = !ok;
}

/**
 * 디바운스된 저장. 체크박스를 빠르게 여러 번 눌러도 마지막 상태만 한 번 저장한다.
 * 페이지를 떠날 때는 flushPendingSave()가 즉시 저장한다.
 */
const saveTodos = debounce(persistTodos, SAVE_DEBOUNCE_MS);

function flushPendingSave() {
  saveTodos.flush();
}

// =============================================================================
// 6. 필터 · 정렬
// =============================================================================

/** 현재 카테고리 필터와 검색어에 맞는지 */
function isVisible(todo) {
  if (currentFilter !== 'all' && todo.category !== currentFilter) return false;
  if (searchQuery && !todo.text.toLowerCase().includes(searchQuery)) return false;
  return true;
}

/** 미완료 → 완료 순으로 나눈다. 각 그룹 안에서는 원래 순서를 유지한다. */
function completedLast(items) {
  return [...items.filter((t) => !t.completed), ...items.filter((t) => t.completed)];
}

/**
 * 정렬 방식에 따라 표시 순서를 정한다. todos 배열 자체는 바꾸지 않는다.
 * (Array.prototype.sort는 안정 정렬이므로 같은 값끼리는 직접 정렬 순서가 유지된다.)
 */
function sortForDisplay(items) {
  switch (sortMode) {
    case 'manual':
      return items;
    case 'newest':
      return [...items].sort((a, b) => timeOf(b) - timeOf(a));
    case 'oldest':
      return [...items].sort((a, b) => timeOf(a) - timeOf(b));
    case 'category': {
      const order = Object.keys(CATEGORIES);
      return [...completedLast(items)].sort(
        (a, b) => order.indexOf(a.category) - order.indexOf(b.category),
      );
    }
    case 'status':
    default:
      return completedLast(items);
  }
}

/** 화면에 보일 항목을 표시 순서대로 */
function getVisibleTodos() {
  return sortForDisplay(todos.filter(isVisible));
}

function findTodo(id) {
  return todos.find((t) => t.id === id);
}

/** 같은 내용의 다른 할 일 (exceptId는 비교에서 제외) */
function findDuplicate(text, exceptId = null) {
  const key = normalizeText(text);
  return todos.find((t) => t.id !== exceptId && normalizeText(t.text) === key);
}

// =============================================================================
// 6-1. 키워드 자동 분류
//
// 새 할 일을 입력하는 동안 CATEGORY_KEYWORDS에서 키워드를 찾아 카테고리를 고른다.
// - 사용자가 드롭다운을 직접 고르지 않았으면 드롭다운 값을 자동으로 바꾼다.
// - 직접 골랐으면 값은 건드리지 않고, 다를 때만 "추천" 버튼을 보여준다.
// - 할 일을 추가하면 직접 선택 표시를 초기화한다.
// =============================================================================

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 키워드 검사기 목록. 긴 키워드부터 검사해야 겹치는 짧은 키워드보다 먼저 자리를 차지한다.
 * @type {{ category: string, word: string, lower: string, regex: RegExp | null }[]}
 */
const KEYWORD_MATCHERS = Object.entries(CATEGORY_KEYWORDS)
  .flatMap(([category, words]) => words.map((word) => {
    const lower = word.toLowerCase();
    const ascii = /^[\x20-\x7e]+$/.test(lower);
    return {
      category,
      word,
      lower,
      // 영어 키워드만 단어 경계(\b) 사용. 한국어는 조사가 붙으므로("회의를") 부분 문자열로 찾는다.
      regex: ascii ? new RegExp(`\\b${escapeRegExp(lower)}\\b`, 'g') : null,
    };
  }))
  .sort((a, b) => b.lower.length - a.lower.length);

/** text 안에서 키워드가 나오는 모든 시작 위치 */
function findKeywordPositions(text, matcher) {
  const positions = [];
  if (matcher.regex) {
    matcher.regex.lastIndex = 0;
    let m;
    while ((m = matcher.regex.exec(text)) !== null) positions.push(m.index);
  } else {
    let i = text.indexOf(matcher.lower);
    while (i !== -1) {
      positions.push(i);
      i = text.indexOf(matcher.lower, i + matcher.lower.length);
    }
  }
  return positions;
}

/**
 * 할 일 내용으로 카테고리를 추측한다.
 *
 * 1) 긴 키워드부터 찾고, 이미 다른 키워드가 차지한 글자와 겹치면 버린다.
 *    → '산책'이 차지한 '책', '머신러닝'이 차지한 '러닝'은 다시 세지 않는다.
 * 2) 카테고리별로 찾은 키워드 개수가 많은 쪽을 고른다.
 * 3) 개수가 같으면 문장에서 더 뒤에 나온 키워드의 카테고리를 고른다.
 *    한국어는 핵심 명사가 뒤에 오기 때문이다 ("영어 회의" → 회의 → 업무).
 *
 * @returns {{ category: string, keyword: string } | null} 키워드가 없으면 null
 */
function classifyText(text) {
  const lower = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!lower) return null;

  const covered = new Uint8Array(lower.length); // 1 = 이미 다른 키워드가 차지한 글자
  /** @type {Map<string, { count: number, lastEnd: number, keyword: string }>} */
  const scores = new Map();

  for (const matcher of KEYWORD_MATCHERS) {
    for (const start of findKeywordPositions(lower, matcher)) {
      const end = start + matcher.lower.length;
      if (covered.subarray(start, end).some(Boolean)) continue;
      covered.fill(1, start, end);

      const score = scores.get(matcher.category) ?? { count: 0, lastEnd: -1, keyword: '' };
      score.count += 1;
      if (end > score.lastEnd) {
        score.lastEnd = end;
        score.keyword = matcher.word; // 힌트에는 가장 뒤쪽 키워드를 보여준다
      }
      scores.set(matcher.category, score);
    }
  }

  let best = null;
  for (const [category, score] of scores) {
    if (!best || score.count > best.count || (score.count === best.count && score.lastEnd > best.lastEnd)) {
      best = { category, ...score };
    }
  }
  return best ? { category: best.category, keyword: best.keyword } : null;
}

/**
 * 입력 내용에 맞춰 드롭다운과 힌트를 갱신한다. 입력할 때마다 호출된다.
 * (키워드 수가 적고 문장이 짧아 디바운스 없이도 충분히 빠르다.)
 */
function updateAutoCategory() {
  if (!autoCategoryEnabled) {
    renderAutoCategoryHint(null);
    return;
  }
  const suggestion = classifyText(dom.input.value);

  if (!categoryTouched) {
    // 키워드가 없으면 사용자가 마지막으로 직접 고른 카테고리로 되돌린다
    const next = suggestion?.category ?? baseCategory;
    if (dom.categorySelect.value !== next) {
      dom.categorySelect.value = next;
      if (suggestion) replayAnimation(dom.categorySelect, 'auto-picked');
    }
    if (suggestion && suggestion.category !== lastAutoCategory) {
      announce(`${CATEGORIES[suggestion.category]} 카테고리로 자동 선택`);
    }
    lastAutoCategory = suggestion?.category ?? null;
    renderAutoCategoryHint(suggestion ? { type: 'auto', ...suggestion } : null);
  } else if (suggestion && suggestion.category !== dom.categorySelect.value) {
    renderAutoCategoryHint({ type: 'suggest', ...suggestion });
  } else {
    renderAutoCategoryHint(null);
  }
}

/** 할 일을 추가한 뒤: 직접 선택 표시를 풀고 기본 카테고리로 돌아간다 */
function resetAutoCategory() {
  categoryTouched = false;
  lastAutoCategory = null;
  dom.categorySelect.value = baseCategory;
  updateAutoCategory();
}

/** "추천" 버튼을 눌렀을 때 */
function applySuggestedCategory(category) {
  if (!isCategory(category)) return;
  dom.categorySelect.value = category;
  replayAnimation(dom.categorySelect, 'auto-picked');
  announce(`${CATEGORIES[category]} 카테고리 선택`);
  updateAutoCategory();
  dom.input.focus();
}

function setAutoCategoryEnabled(enabled) {
  autoCategoryEnabled = enabled;
  writeStorage(STORAGE_KEYS.autoCategory, enabled ? 'on' : 'off');
  if (enabled) {
    updateAutoCategory();
  } else {
    // 자동으로 바꿔 둔 값은 되돌리고, 직접 고른 값은 유지
    if (!categoryTouched) dom.categorySelect.value = baseCategory;
    lastAutoCategory = null;
    renderAutoCategoryHint(null);
  }
  showToast(enabled ? '키워드 자동 분류를 켰습니다.' : '키워드 자동 분류를 껐습니다.');
}

/**
 * 입력창 아래 힌트.
 * - auto: "🏷️ '회의' → [업무]"  (자동으로 골랐음을 알림)
 * - suggest: "[추천: 업무 ('회의')]" 버튼  (직접 고른 값과 다를 때)
 */
function renderAutoCategoryHint(state) {
  const hint = dom.autoCategoryHint;
  hint.replaceChildren();
  if (!state) return;

  const tag = document.createElement('span');
  tag.className = `category-tag category-tag--${state.category}`;
  tag.textContent = CATEGORIES[state.category];

  if (state.type === 'auto') {
    hint.append(`🏷️ '${state.keyword}' → `, tag);
    return;
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'auto-category__suggest';
  btn.setAttribute('aria-label', `추천 카테고리 ${CATEGORIES[state.category]} 적용 (키워드: ${state.keyword})`);
  btn.append('추천: ', tag, ` ('${state.keyword}')`);
  btn.addEventListener('click', () => applySuggestedCategory(state.category));
  hint.append(btn);
}

// =============================================================================
// 7. 할 일 조작
// =============================================================================

function addTodo(text, category) {
  const todo = {
    id: generateId(),
    text: text.slice(0, MAX_TEXT_LENGTH),
    completed: false,
    createdAt: new Date().toISOString(),
    category: isCategory(category) ? category : DEFAULT_CATEGORY,
  };
  todos.push(todo);
  entryAnimations.set(todo.id, 'fade-in');
  saveTodos();
  render();
  announce(`'${truncate(todo.text)}' ${CATEGORIES[todo.category]}에 추가됨`);
  notifyIfHidden(todo, `${CATEGORIES[todo.category]} 카테고리에 추가했습니다.`);
}

let submitting = false; // 중복 확인 대화상자가 떠 있는 동안 다시 제출되지 않도록

/** 입력 폼 제출: 검증 → 중복 확인 → 추가 */
async function submitNewTodo() {
  if (submitting) return;
  const text = dom.input.value.trim();

  if (!text) {
    replayAnimation(dom.input, 'shake');
    dom.input.focus();
    announce('할 일 내용을 입력하세요.');
    return;
  }

  submitting = true;
  try {
    const duplicate = findDuplicate(text);
    if (duplicate) {
      const status = duplicate.completed ? '완료됨' : '진행 중';
      const ok = await confirmAction({
        title: '중복된 할 일',
        message: `같은 할 일이 이미 있습니다: "${truncate(duplicate.text, 40)}" (${CATEGORIES[duplicate.category]}, ${status}). 그래도 추가할까요?`,
        confirmLabel: '그래도 추가',
      });
      if (!ok) {
        dom.input.focus();
        dom.input.select();
        return;
      }
    }
    addTodo(text, dom.categorySelect.value);
    dom.input.value = '';
    resetAutoCategory();
    dom.input.focus();
  } finally {
    submitting = false;
  }
}

/**
 * ids에 해당하는 항목을 지우고, 되돌리기용으로 원래 위치(index)와 함께 반환한다.
 * @returns {{ todo: Todo, index: number }[]}
 */
function removeTodos(ids) {
  const removed = [];
  todos.forEach((todo, index) => {
    if (ids.has(todo.id)) removed.push({ todo, index });
  });
  if (removed.length === 0) return removed;
  todos = todos.filter((todo) => !ids.has(todo.id));
  if (ids.has(editingId)) editingId = null;
  saveTodos();
  render();
  return removed;
}

/**
 * removeTodos가 반환한 항목을 원래 자리에 되돌린다.
 * index 오름차순으로 넣어야 여러 개를 지웠을 때도 원래 순서가 복원된다.
 */
function restoreTodos(removed) {
  const restoredIds = [];
  for (const { todo, index } of removed) {
    if (todos.some((t) => t.id === todo.id)) continue; // 이미 있으면(다른 탭 등) 건너뜀
    todos.splice(Math.min(index, todos.length), 0, todo);
    entryAnimations.set(todo.id, 'fade-in');
    restoredIds.push(todo.id);
  }
  saveTodos();
  render();
  if (restoredIds.length > 0) focusTodo(restoredIds[0]);
}

function deleteTodo(id) {
  // 삭제 후 포커스를 옮길 이웃 항목을 미리 기억 (다음 항목, 없으면 이전 항목)
  const visible = getVisibleTodos();
  const pos = visible.findIndex((t) => t.id === id);
  const neighbor = visible[pos + 1] ?? visible[pos - 1];

  const removed = removeTodos(new Set([id]));
  if (removed.length === 0) return;

  const label = `'${truncate(removed[0].todo.text)}' 삭제`;
  const entry = pushUndo(label, () => restoreTodos(removed));
  showToast(`${label}됨`, { action: undoActionFor(entry) });

  if (!neighbor || !focusTodo(neighbor.id)) dom.input.focus();
}

/**
 * 완료 상태를 뒤집는다.
 * @param {{ refocus?: boolean }} options refocus: 키보드로 조작했다면 이동한 항목에 포커스를 다시 줌
 */
function toggleTodo(id, { refocus = false } = {}) {
  const todo = findTodo(id);
  if (!todo) {
    render(); // 애니메이션 도중 다른 탭에서 삭제된 경우: 흐려진 노드를 정리
    return;
  }
  const remainingBefore = countRemaining();
  todo.completed = !todo.completed;
  entryAnimations.set(id, 'slide-in');
  saveTodos();
  render();
  if (refocus) focusTodo(id);

  announce(`'${truncate(todo.text)}' ${todo.completed ? '완료' : '미완료로 변경'}`);
  if (remainingBefore > 0 && countRemaining() === 0) {
    showToast('🎉 모든 할 일을 완료했습니다!');
  }
}

async function clearCompleted() {
  const completed = todos.filter((t) => t.completed);
  if (completed.length === 0) {
    showToast('삭제할 완료 항목이 없습니다.');
    return;
  }
  const ok = await confirmAction({
    title: '완료된 항목 삭제',
    message: `완료된 할 일 ${completed.length}개를 모두 삭제할까요? 현재 필터와 관계없이 모든 카테고리에서 삭제됩니다. 삭제 후 되돌리기로 복구할 수 있습니다.`,
    confirmLabel: '삭제',
    danger: true,
  });
  if (!ok) return;

  // 화면에 보이는 완료 항목만 동시에 사라지는 애니메이션 후 삭제
  const ids = new Set(completed.map((t) => t.id));
  const leaving = [...dom.list.children].filter((li) => ids.has(li.dataset.id));
  await Promise.all(leaving.map((li) => animateOut(li, 'fade-out')));

  const removed = removeTodos(ids);
  if (removed.length === 0) return;
  const label = `완료 항목 ${removed.length}개 삭제`;
  const entry = pushUndo(label, () => restoreTodos(removed));
  showToast(`완료된 항목 ${removed.length}개를 삭제했습니다.`, { action: undoActionFor(entry) });
  dom.input.focus(); // 누른 버튼이 비활성화되므로 포커스를 입력창으로
}

/** 화면에 보이는 항목의 새 순서(newIds)를 todos 배열에 반영한다. */
function reorderVisible(newIds) {
  // 보이는 항목들이 todos에서 차지하던 자리(slot)에 새 순서대로 다시 채운다.
  // 필터·검색으로 숨겨진 항목의 위치는 그대로 유지된다.
  const idSet = new Set(newIds);
  const slots = [];
  todos.forEach((t, i) => {
    if (idSet.has(t.id)) slots.push(i);
  });
  if (slots.length !== newIds.length) {
    // 드래그 도중 다른 탭에서 데이터가 바뀌는 등 상태가 어긋난 경우: 반영하지 않고 원래대로
    render();
    return false;
  }
  const byId = new Map(todos.map((t) => [t.id, t]));
  const next = todos.slice();
  slots.forEach((slot, k) => {
    next[slot] = byId.get(newIds[k]);
  });
  const changed = next.some((t, i) => t !== todos[i]);
  todos = next;
  if (changed) saveTodos();
  render();
  return changed;
}

/** 키보드로 순서 이동 (드래그 손잡이에서 ↑/↓) */
function moveTodoBy(id, delta) {
  if (sortMode !== 'manual') {
    showToast("순서는 '직접 정렬'에서만 바꿀 수 있습니다.");
    return;
  }
  const ids = getVisibleTodos().map((t) => t.id);
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from === -1) return;
  if (to < 0 || to >= ids.length) {
    announce(to < 0 ? '이미 맨 위입니다.' : '이미 맨 아래입니다.');
    return;
  }
  [ids[from], ids[to]] = [ids[to], ids[from]];
  reorderVisible(ids);
  focusTodo(id, '.todo-item__handle');
  announce(`${ids.length}개 중 ${to + 1}번째로 이동`);
}

function setFilter(filter) {
  if (!FILTERS.includes(filter) || filter === currentFilter) {
    renderFilterButtons();
    return;
  }
  currentFilter = filter;
  writeStorage(STORAGE_KEYS.filter, filter);
  render();
  const label = filter === 'all' ? '전체' : CATEGORIES[filter];
  announce(`${label} 필터, ${getVisibleTodos().length}개 표시`);
}

function setSort(mode) {
  if (!Object.hasOwn(SORTS, mode)) {
    dom.sortSelect.value = sortMode;
    return;
  }
  sortMode = mode;
  writeStorage(STORAGE_KEYS.sort, mode);
  render();
  announce(`${SORTS[mode]}으로 정렬`);
  if (mode === 'manual') {
    showToast('⋮⋮ 손잡이를 끌거나, 손잡이에서 ↑/↓ 키로 순서를 바꿀 수 있습니다.');
  }
}

function setSearch(raw) {
  const trimmed = raw.trim();
  const query = trimmed.toLowerCase();
  if (query === searchQuery) return;
  searchRaw = trimmed;
  searchQuery = query;
  render();
  if (query) announce(`검색 결과 ${getVisibleTodos().length}개`);
}

/** 검색은 타이핑이 멈춘 뒤 실행 (100개 이상에서 매 키 입력마다 다시 그리지 않도록) */
const debouncedSearch = debounce(setSearch, SEARCH_DEBOUNCE_MS);

/** 필터·검색을 모두 풀어 전체 목록을 보여준다 */
function showAll() {
  debouncedSearch.cancel();
  dom.searchInput.value = '';
  setSearch('');
  setFilter('all');
}

// --- 인라인 편집 ---

function startEdit(id) {
  if (editingId === id) return;
  if (editingId !== null) commitOpenEditor(); // 다른 항목을 편집 중이면 먼저 저장
  if (!findTodo(id)) return;
  editingId = id;
  render();
  const editInput = nodeCache.get(id)?.el.querySelector('.todo-edit__input');
  if (editInput) {
    editInput.focus();
    editInput.select();
  }
}

/** 화면에 열린 편집기가 있으면 그 값으로 저장 */
function commitOpenEditor(options) {
  const editor = dom.list.querySelector('.todo-edit');
  if (editor) commitFromEditor(editor, options);
  else editingId = null;
}

function commitFromEditor(editor, options) {
  const id = editor.closest('.todo-item')?.dataset.id;
  commitEdit(
    id,
    editor.querySelector('.todo-edit__input').value,
    editor.querySelector('.todo-edit__select').value,
    options,
  );
}

/**
 * 편집 내용을 저장한다.
 * editingId를 render 전에 먼저 비워야, render가 편집기를 지울 때 발생하는 focusout이
 * 같은 저장을 다시 실행하지 않는다.
 * @param {{ refocus?: boolean }} options refocus: Enter/Esc로 끝냈으면 그 항목의 수정 버튼으로 포커스 복귀
 */
function commitEdit(id, text, category, { refocus = false } = {}) {
  if (id === undefined || editingId !== id) return;
  editingId = null;

  const todo = findTodo(id);
  const trimmed = text.trim().slice(0, MAX_TEXT_LENGTH);
  const changed = Boolean(todo && trimmed && isCategory(category) &&
    (trimmed !== todo.text || category !== todo.category));

  if (changed) {
    const previous = { text: todo.text, category: todo.category };
    todo.text = trimmed;
    todo.category = category;
    entryAnimations.set(id, 'flash');
    saveTodos();
    pushUndo(`'${truncate(previous.text)}' 수정`, () => {
      const target = findTodo(id);
      if (!target) return;
      Object.assign(target, previous);
      entryAnimations.set(id, 'flash');
      saveTodos();
      render();
    });
  } else if (todo && !trimmed) {
    showToast('내용이 비어 있어 수정하지 않았습니다.');
  }

  render();
  if (refocus && !focusTodo(id, '.todo-item__edit')) dom.input.focus();

  if (changed) {
    announce('수정됨');
    if (findDuplicate(trimmed, id)) showToast('같은 내용의 할 일이 이미 있습니다.');
    notifyIfHidden(todo, '수정했습니다.');
  }
}

function cancelEdit({ refocus = false } = {}) {
  const id = editingId;
  if (id === null) return;
  editingId = null;
  render();
  announce('수정 취소');
  if (refocus) focusTodo(id, '.todo-item__edit');
}

// =============================================================================
// 8. 되돌리기 (Undo)
// =============================================================================

/**
 * 되돌릴 수 있는 작업을 기록한다.
 * @param {string} label 사용자에게 보여줄 작업 이름
 * @param {() => void} undo 작업을 되돌리는 함수
 */
function pushUndo(label, undo) {
  const entry = { label, undo };
  undoStack.push(entry);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  renderUndoButton();
  return entry;
}

/** 특정 기록을 되돌린다 (토스트의 "되돌리기"는 자기 작업만 되돌림) */
function runUndo(entry) {
  const index = undoStack.lastIndexOf(entry);
  if (index === -1) return; // 이미 되돌렸거나 기록에서 밀려남
  undoStack.splice(index, 1);
  try {
    entry.undo();
    showToast(`되돌림: ${entry.label}`);
  } catch (err) {
    console.error('되돌리기 실패:', err);
    showToast('되돌리지 못했습니다.', { type: 'error' });
  }
  renderUndoButton();
}

/** 가장 최근 작업을 되돌린다 (Ctrl+Z, 되돌리기 버튼) */
function undoLast() {
  const entry = undoStack.at(-1);
  if (!entry) {
    showToast('되돌릴 작업이 없습니다.');
    return;
  }
  runUndo(entry);
}

function undoActionFor(entry) {
  return { label: '되돌리기', onClick: () => runUndo(entry) };
}

// =============================================================================
// 9. 내보내기 · 가져오기
// =============================================================================

/** 메모리의 데이터로 JSON 파일을 만들어 다운로드한다. @returns {boolean} 성공 여부 */
function downloadTodos(filename) {
  try {
    const data = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      todos,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    // 다운로드가 시작될 시간을 준 뒤 메모리 해제
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (err) {
    console.error('내보내기 실패:', err);
    showToast('파일을 만들지 못했습니다.', { type: 'error' });
    return false;
  }
}

function exportTodos() {
  if (todos.length === 0) {
    showToast('내보낼 할 일이 없습니다.');
    return;
  }
  if (downloadTodos(`my-tasks-${formatDateForFile()}.json`)) {
    showToast(`할 일 ${todos.length}개를 파일로 내보냈습니다.`);
  }
}

/**
 * 파일 내용을 검증해 Todo 목록으로 바꾼다. 문제가 있으면 사용자에게 보여줄 메시지로 Error를 던진다.
 * 이 앱이 내보낸 { format, todos } 형식과, 할 일 배열만 있는 JSON 둘 다 받는다.
 */
function parseImportText(text) {
  if (!text.trim()) throw new Error('파일이 비어 있습니다.');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('JSON 형식이 올바르지 않습니다.');
  }

  let rawList;
  if (Array.isArray(parsed)) {
    rawList = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.todos)) {
    if (parsed.format !== undefined && parsed.format !== EXPORT_FORMAT) {
      throw new Error('My Tasks에서 내보낸 파일이 아닙니다.');
    }
    if (typeof parsed.version === 'number' && parsed.version > EXPORT_VERSION) {
      throw new Error('더 새로운 버전의 앱에서 만든 파일이라 가져올 수 없습니다.');
    }
    rawList = parsed.todos;
  } else {
    throw new Error('파일에서 할 일 목록을 찾을 수 없습니다.');
  }

  const result = sanitizeTodoList(rawList);
  if (result.items.length === 0) {
    throw new Error(rawList.length === 0 ? '파일에 할 일이 없습니다.' : '가져올 수 있는 올바른 할 일이 없습니다.');
  }
  return result;
}

/** 파일 선택 후 실행: 읽기 → 검증 → 옵션 선택(백업 포함) → 적용 */
async function importFromFile(file) {
  if (!file) return;

  if (file.size > MAX_IMPORT_BYTES) {
    showToast(`파일이 너무 큽니다 (최대 ${MAX_IMPORT_BYTES / 1024 / 1024}MB).`, { type: 'error' });
    return;
  }
  const looksLikeJson = /\.json$/i.test(file.name) || file.type.includes('json');
  if (!looksLikeJson) {
    showToast('JSON 파일(.json)만 가져올 수 있습니다.', { type: 'error' });
    return;
  }

  let text;
  try {
    text = await file.text();
  } catch (err) {
    console.error('파일 읽기 실패:', err);
    showToast('파일을 읽지 못했습니다.', { type: 'error' });
    return;
  }

  let imported;
  try {
    imported = parseImportText(text);
  } catch (err) {
    showToast(`가져오기 실패: ${err.message}`, { type: 'error', duration: 7000 });
    return;
  }

  const { items, invalid } = imported;
  const invalidNote = invalid > 0 ? ` (올바르지 않은 항목 ${invalid}개는 제외)` : '';

  // 현재 데이터가 있으면 방식과 백업 여부를 묻는다. 비어 있으면 바로 가져온다.
  let options = { mode: 'replace', backup: false };
  if (todos.length > 0) {
    options = await chooseImportOptions(
      `"${truncate(file.name, 40)}"에서 할 일 ${items.length}개를 찾았습니다${invalidNote}. 현재 목록에는 ${todos.length}개가 있습니다.`,
    );
    if (!options) {
      announce('가져오기를 취소했습니다.');
      return;
    }
  }

  if (options.backup && !downloadTodos(`my-tasks-backup-${formatDateForFile()}.json`)) {
    // 백업을 원했는데 실패했다면 데이터를 덮어쓰지 않고 중단
    showToast('백업 파일을 만들지 못해 가져오기를 중단했습니다.', { type: 'error' });
    return;
  }

  applyImport(items, options.mode, invalidNote);
}

/** 가져온 항목을 상태에 반영하고 되돌리기를 기록한다. */
function applyImport(items, mode, invalidNote) {
  if (editingId !== null) commitOpenEditor();

  if (mode === 'replace') {
    // 이후 토글 등으로 객체가 바뀌어도 원래 상태로 돌아갈 수 있도록 깊은 복사로 보관
    const snapshot = todos.map((t) => ({ ...t }));
    todos = items;
    items.forEach((t) => entryAnimations.set(t.id, 'fade-in'));
    saveTodos();
    render();
    const entry = pushUndo('가져오기(바꾸기)', () => {
      todos = snapshot;
      saveTodos();
      render();
    });
    showToast(`할 일 ${items.length}개로 목록을 바꿨습니다${invalidNote}.`, { action: undoActionFor(entry) });
    return;
  }

  // 합치기: 같은 id가 이미 있으면 같은 항목으로 보고 건너뛴다
  const existingIds = new Set(todos.map((t) => t.id));
  const added = items.filter((t) => !existingIds.has(t.id));
  const skipped = items.length - added.length;

  if (added.length === 0) {
    showToast(`새로 추가할 항목이 없습니다. ${skipped}개 모두 이미 목록에 있습니다.`);
    return;
  }

  todos.push(...added);
  added.forEach((t) => entryAnimations.set(t.id, 'fade-in'));
  saveTodos();
  render();

  const addedIds = new Set(added.map((t) => t.id));
  const entry = pushUndo(`가져오기 ${added.length}개`, () => {
    todos = todos.filter((t) => !addedIds.has(t.id));
    if (addedIds.has(editingId)) editingId = null;
    saveTodos();
    render();
  });
  const skippedNote = skipped > 0 ? `, 이미 있는 ${skipped}개는 건너뜀` : '';
  showToast(`할 일 ${added.length}개를 가져왔습니다${skippedNote}${invalidNote}.`, { action: undoActionFor(entry) });
}

// =============================================================================
// 10. 테마
// =============================================================================

function getTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme, { animate = false } = {}) {
  const root = document.documentElement;
  if (animate) {
    // 전환하는 동안만 모든 요소에 색 트랜지션을 건다 (평소에는 다른 트랜지션과 섞이지 않게)
    root.classList.add('theme-transition');
    clearTimeout(themeTransitionTimer);
    themeTransitionTimer = setTimeout(() => root.classList.remove('theme-transition'), THEME_TRANSITION_MS);
  }
  root.dataset.theme = theme;
  const dark = theme === 'dark';
  dom.themeToggle.setAttribute('aria-checked', String(dark));
  dom.themeToggle.title = dark ? '라이트 모드로 전환 (Alt+D)' : '다크 모드로 전환 (Alt+D)';
}

function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next, { animate: true });
  writeStorage(STORAGE_KEYS.theme, next);
  showToast(next === 'dark' ? '🌙 다크 모드' : '☀️ 라이트 모드');
}

// =============================================================================
// 11. 피드백: 스크린 리더 알림 · 토스트 · 대화상자 · 애니메이션
// =============================================================================

/**
 * 화면에는 보이지 않는 상태 영역에 문장을 넣어 스크린 리더가 읽게 한다.
 * 같은 문장을 연달아 넣어도 다시 읽히도록 한 번 비운 뒤 다음 프레임에 넣는다.
 */
function announce(message) {
  dom.srStatus.textContent = '';
  requestAnimationFrame(() => {
    dom.srStatus.textContent = message;
  });
}

/**
 * 화면 하단에 잠깐 메시지를 보여준다. 컨테이너가 aria-live라 스크린 리더도 읽는다.
 * @param {string} message
 * @param {{ type?: 'error', action?: { label: string, onClick: () => void }, duration?: number }} [options]
 */
function showToast(message, { type, action, duration = TOAST_MS } = {}) {
  const toast = document.createElement('div');
  toast.className = 'toast' + (type ? ` toast--${type}` : '');
  if (type === 'error') toast.setAttribute('role', 'alert');

  const text = document.createElement('span');
  text.className = 'toast__message';
  text.textContent = message;
  toast.append(text);

  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    if (toast.classList.contains('is-leaving')) return;
    animateOut(toast, 'toast--leaving').then(() => toast.remove());
  };

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast__action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.onClick();
      dismiss();
    }, { once: true });
    toast.append(btn);
  }

  // 마우스를 올리거나 포커스가 있는 동안에는 사라지지 않게 (되돌리기를 누를 시간 확보)
  const pause = () => clearTimeout(timer);
  const resume = () => {
    clearTimeout(timer);
    timer = setTimeout(dismiss, duration);
  };
  toast.addEventListener('pointerenter', pause);
  toast.addEventListener('pointerleave', resume);
  toast.addEventListener('focusin', pause);
  toast.addEventListener('focusout', resume);

  dom.toastContainer.append(toast);
  const active = dom.toastContainer.querySelectorAll('.toast:not(.is-leaving)');
  if (active.length > MAX_TOASTS) active[0].remove();

  resume();
}

/** 방금 추가/수정한 항목이 현재 필터·검색 때문에 안 보이면 알려주고 "모두 보기"를 제공 */
function notifyIfHidden(todo, message) {
  if (isVisible(todo)) return;
  showToast(`${message} 현재 필터나 검색 조건에서는 보이지 않습니다.`, {
    action: { label: '모두 보기', onClick: showAll },
  });
}

/**
 * <dialog>를 모달로 열고 닫힐 때까지 기다린다.
 * 닫히면 연 사람(이전 포커스)에게 포커스를 돌려준다.
 * @returns {Promise<string>} dialog.returnValue ('confirm' | 'cancel' | '')
 */
function openDialog(dialog) {
  const opener = document.activeElement;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      resolve(dialog.returnValue);
    }, { once: true });
  });
}

function supportsDialog() {
  return typeof HTMLDialogElement === 'function' && typeof dom.confirmDialog.showModal === 'function';
}

/**
 * 확인 대화상자. <dialog>를 지원하지 않으면 window.confirm으로 대체한다.
 * @returns {Promise<boolean>}
 */
async function confirmAction({ title, message, confirmLabel = '확인', danger = false }) {
  if (!supportsDialog()) return window.confirm(`${title}\n\n${message}`);
  dom.confirmTitle.textContent = title;
  dom.confirmMessage.textContent = message;
  dom.confirmOk.textContent = confirmLabel;
  dom.confirmOk.classList.toggle('btn--danger', danger);
  dom.confirmOk.classList.toggle('btn--primary', !danger);
  return (await openDialog(dom.confirmDialog)) === 'confirm';
}

/**
 * 가져오기 방식과 백업 여부를 묻는다.
 * @returns {Promise<{ mode: 'merge' | 'replace', backup: boolean } | null>} 취소하면 null
 */
async function chooseImportOptions(summary) {
  if (!supportsDialog()) {
    const ok = window.confirm(`${summary}\n\n현재 데이터를 백업 파일로 저장한 뒤 기존 목록에 합칠까요?`);
    return ok ? { mode: 'merge', backup: true } : null;
  }
  dom.importSummary.textContent = summary;
  dom.importDialog.querySelector('input[name="import-mode"][value="merge"]').checked = true;
  dom.importBackup.checked = true;

  const result = await openDialog(dom.importDialog);
  if (result !== 'confirm') return null;
  const mode = dom.importDialog.querySelector('input[name="import-mode"]:checked')?.value;
  return { mode: mode === 'replace' ? 'replace' : 'merge', backup: dom.importBackup.checked };
}

/** 요소에 퇴장 애니메이션 클래스를 붙이고 끝날 때까지 기다린다. */
function animateOut(el, className) {
  el.classList.add('is-leaving', className);
  return new Promise((resolve) => {
    let timer = 0;
    const done = () => {
      clearTimeout(timer);
      el.removeEventListener('animationend', onEnd);
      resolve();
    };
    // 자식 요소의 애니메이션이 버블링되어 일찍 끝나지 않도록 자기 자신의 것만 받는다
    const onEnd = (e) => {
      if (e.target === el) done();
    };
    timer = setTimeout(done, ANIMATION_FALLBACK_MS);
    el.addEventListener('animationend', onEnd);
  });
}

/**
 * 같은 애니메이션을 처음부터 다시 재생한다.
 * 클래스가 이미 붙어 있을 때만 강제 reflow를 한다. 새로 만든 요소에는 그냥 붙이면 되므로,
 * 수백 개를 한꺼번에 가져올 때 reflow가 수백 번 일어나지 않는다.
 */
function replayAnimation(el, className) {
  if (el.classList.contains(className)) {
    el.classList.remove(className);
    void el.offsetWidth; // 강제 reflow로 애니메이션 상태 초기화
  }
  el.classList.add(className);
}

/**
 * 항목 안의 요소에 포커스를 준다.
 * @returns {boolean} 포커스를 줬는지 (항목이 화면에 없으면 false)
 */
function focusTodo(id, selector = '.todo-item__checkbox') {
  const el = nodeCache.get(id)?.el;
  if (!el || !el.isConnected) return false;
  const target = el.querySelector(selector);
  if (!target) return false;
  target.focus();
  return true;
}

// =============================================================================
// 12. 렌더링
// =============================================================================

/** 할 일 통계를 한 번의 순회로 계산한다 (100개 이상에서도 filter를 여러 번 돌지 않도록). */
function computeStats() {
  const stats = {
    total: todos.length,
    done: 0,
    today: 0,
    byCategory: Object.fromEntries(Object.keys(CATEGORIES).map((c) => [c, { total: 0, done: 0 }])),
  };
  // 오늘 0시~내일 0시 (로컬 시간). 문자열 비교보다 숫자 비교가 빠르다.
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  const endMs = startMs + 24 * 60 * 60 * 1000;
  for (const t of todos) {
    const cat = stats.byCategory[t.category];
    if (cat) cat.total += 1;
    if (t.completed) {
      stats.done += 1;
      if (cat) cat.done += 1;
    }
    const created = timeOf(t);
    if (created >= startMs && created < endMs) stats.today += 1;
  }
  return stats;
}

function countRemaining() {
  let n = 0;
  for (const t of todos) if (!t.completed) n += 1;
  return n;
}

/** 완료율에 따른 응원 메시지 */
function cheerMessage(done, total) {
  if (total === 0) return '첫 번째 할 일을 추가해 보세요! ✏️';
  if (done === total) return '🎉 모두 완료! 오늘 정말 잘했어요.';
  if (done === 0) return '시작이 반이에요. 하나씩 해볼까요? 🌱';
  const p = (done / total) * 100;
  if (p < 25) return '좋은 출발이에요! 💪';
  if (p < 50) return '잘하고 있어요, 이 기세로 계속! 🚶';
  if (p < 75) return '절반을 넘었어요! 🔥';
  return '거의 다 왔어요, 조금만 더! 🏁';
}

/** 검색어와 일치하는 부분을 <mark>로 감싸서 넣는다 (텍스트 노드만 쓰므로 XSS 안전). */
function appendHighlighted(el, text) {
  if (!searchQuery) {
    el.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  let pos = 0;
  let hit;
  while ((hit = lower.indexOf(searchQuery, pos)) !== -1) {
    el.append(text.slice(pos, hit));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(hit, hit + searchQuery.length);
    el.append(mark);
    pos = hit + searchQuery.length;
  }
  el.append(text.slice(pos));
}

function createIconButton(className, icon, label, title = label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `icon-btn ${className}`;
  btn.textContent = icon;
  btn.setAttribute('aria-label', label);
  btn.title = title;
  return btn;
}

function createEditor(todo) {
  const editor = document.createElement('div');
  editor.className = 'todo-edit';

  const editInput = document.createElement('input');
  editInput.type = 'text';
  editInput.className = 'todo-edit__input';
  editInput.value = todo.text;
  editInput.maxLength = MAX_TEXT_LENGTH;
  editInput.setAttribute('aria-label', '할 일 수정, Enter로 저장, Esc로 취소');

  const editSelect = document.createElement('select');
  editSelect.className = 'todo-edit__select';
  editSelect.setAttribute('aria-label', '카테고리 수정');
  for (const [value, label] of Object.entries(CATEGORIES)) {
    editSelect.add(new Option(label, value, false, value === todo.category));
  }

  editor.append(editInput, editSelect);
  return editor;
}

/**
 * 항목 하나의 <li>를 만든다. 순서: 드래그 손잡이, 체크박스, 본문(텍스트·태그·시간), 수정, 삭제.
 * 드래그 손잡이는 항상 만들고, '직접 정렬'일 때만 CSS로 보인다
 * (정렬을 바꿔도 노드를 다시 만들 필요가 없도록).
 */
function createTodoElement(todo) {
  const editing = todo.id === editingId;
  const short = truncate(todo.text, 30);

  const li = document.createElement('li');
  li.className = 'todo-item';
  li.classList.toggle('completed', todo.completed);
  li.classList.toggle('editing', editing);
  li.dataset.id = todo.id;
  // 등장 애니메이션이 끝나면 클래스를 지워 재사용될 때 다시 재생되지 않게 한다
  li.addEventListener('animationend', (e) => {
    if (e.target === li) li.classList.remove('fade-in', 'slide-in', 'flash');
  });

  const handle = createIconButton(
    'todo-item__handle',
    '⋮⋮',
    `'${short}' 순서 이동. 위아래 화살표 키로 이동`,
    '끌어서 순서 변경 (↑/↓ 키)',
  );

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'todo-item__checkbox';
  checkbox.checked = todo.completed;
  checkbox.setAttribute('aria-label', `${todo.text} (${CATEGORIES[todo.category]})`);

  const body = document.createElement('div');
  body.className = 'todo-item__body';

  if (editing) {
    body.append(createEditor(todo));
  } else {
    const text = document.createElement('span');
    text.className = 'todo-item__text';
    text.title = '더블클릭하여 수정';
    appendHighlighted(text, todo.text);
    body.append(text);
  }

  const meta = document.createElement('div');
  meta.className = 'todo-item__meta';

  const tag = document.createElement('span');
  tag.className = `category-tag category-tag--${todo.category}`;
  tag.textContent = CATEGORIES[todo.category];

  const time = document.createElement('time');
  time.className = 'todo-item__time';
  time.dateTime = todo.createdAt;
  time.title = new Date(todo.createdAt).toLocaleString('ko-KR');
  time.textContent = formatRelativeTime(todo.createdAt);

  meta.append(tag, time);
  body.append(meta);

  li.append(handle, checkbox, body);
  if (!editing) li.append(createIconButton('todo-item__edit', '✎', `'${short}' 수정`, '수정'));
  li.append(createIconButton('todo-item__delete', '✕', `'${short}' 삭제`, '삭제'));
  return li;
}

/**
 * 항목의 내용 서명. 화면에 영향을 주는 값이 하나라도 바뀌면 달라진다.
 * 서명이 같으면 기존 <li>를 재사용한다.
 * 검색어는 서명에 넣지 않는다. 검색어가 바뀔 때마다 모든 <li>를 다시 만들지 않고,
 * getTodoElement가 텍스트 부분의 하이라이트만 다시 그린다.
 */
function signatureOf(todo) {
  return [
    todo.text,
    todo.completed,
    todo.category,
    todo.createdAt,
    todo.id === editingId,
  ].join('\u0000');
}

/** 캐시에서 <li>를 가져오거나, 내용이 바뀌었으면 새로 만든다. */
function getTodoElement(todo) {
  const sig = signatureOf(todo);
  const cached = nodeCache.get(todo.id);
  if (cached && cached.sig === sig) {
    // 퇴장 애니메이션이 중간에 취소된 노드라면 원래 모습으로 되돌린다
    cached.el.classList.remove('is-leaving', 'fade-out', 'slide-out', 'dragging');
    // 검색어가 바뀌었으면 하이라이트만 갱신
    if (cached.query !== searchQuery) {
      const textEl = cached.el.querySelector('.todo-item__text');
      if (textEl) {
        textEl.replaceChildren();
        appendHighlighted(textEl, todo.text);
      }
      cached.query = searchQuery;
    }
    return cached.el;
  }
  const el = createTodoElement(todo);
  nodeCache.set(todo.id, { el, sig, query: searchQuery });
  return el;
}

/**
 * 목록 DOM을 elements 순서와 같게 맞춘다. 이미 제자리에 있는 노드는 건드리지 않고
 * 필요한 노드만 옮기거나 추가한다.
 *
 * 1) 더 이상 보이지 않는 노드(삭제·필터·내용 변경으로 교체된 노드)를 먼저 제거한다.
 *    그래야 낡은 노드가 커서를 막아 뒤의 모든 노드가 한 칸씩 옮겨지는 일이 없다.
 * 2) 앞에서부터 차례로 비교한다. 커서 노드 하나만 제자리를 벗어난 경우(예: 맨 위 항목이
 *    완료되어 아래로 감)에는 그 노드만 맨 뒤로 보내 나머지를 그대로 둔다.
 * 따라서 항목 하나가 이동하면 DOM 이동도 한 번만 일어난다.
 */
function reconcileList(elements) {
  const wanted = new Set(elements);
  for (const child of [...dom.list.children]) {
    if (!wanted.has(child)) child.remove();
  }

  let cursor = dom.list.firstElementChild;
  for (const el of elements) {
    if (el === cursor) {
      cursor = cursor.nextElementSibling;
    } else if (cursor && cursor.nextElementSibling === el) {
      // 커서 노드만 자리를 벗어남: 맨 뒤로 보내 두면, 그 노드 차례가 왔을 때 제자리에 놓인다
      dom.list.append(cursor);
      cursor = el.nextElementSibling;
    } else {
      dom.list.insertBefore(el, cursor);
    }
  }
}

/** 삭제된 항목의 캐시를 정리한다 (메모리 누수 방지). */
function pruneNodeCache() {
  if (nodeCache.size <= todos.length) return;
  const ids = new Set(todos.map((t) => t.id));
  for (const id of nodeCache.keys()) {
    if (!ids.has(id)) nodeCache.delete(id);
  }
}

function renderFilterButtons() {
  for (const btn of dom.filterBar.querySelectorAll('.filter-btn')) {
    const active = btn.dataset.filter === currentFilter;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
}

function renderEmptyState(visibleCount) {
  dom.empty.hidden = visibleCount > 0;
  if (visibleCount > 0) return;
  if (todos.length === 0) {
    dom.empty.textContent = '할 일이 없습니다. 추가해보세요!';
  } else if (searchQuery) {
    dom.empty.textContent = `'${searchRaw}'에 해당하는 할 일이 없습니다.`;
  } else {
    dom.empty.textContent = `${CATEGORIES[currentFilter] ?? ''} 카테고리에 할 일이 없습니다.`;
  }
}

function renderBadge(remaining) {
  dom.badge.textContent = String(remaining);
  dom.badge.classList.toggle('badge--zero', remaining === 0);
  dom.badge.setAttribute('aria-label', `남은 할 일 ${remaining}개`);
  dom.badge.title = `남은 할 일 ${remaining}개`;
  if (lastRemaining !== null && lastRemaining !== remaining) {
    replayAnimation(dom.badge, 'bump');
  }
  lastRemaining = remaining;
}

function renderClearButton(completed) {
  dom.clearCompletedBtn.disabled = completed === 0;
  dom.clearCompletedBtn.textContent = completed > 0 ? `완료 항목 삭제 (${completed})` : '완료 항목 삭제';
}

function renderUndoButton() {
  const last = undoStack.at(-1);
  dom.undoBtn.disabled = !last;
  dom.undoBtn.title = last ? `되돌리기: ${last.label} (Ctrl+Z)` : '되돌릴 작업이 없습니다';
}

/**
 * 대시보드. 막대 요소를 다시 만들지 않고 width만 바꾸므로 CSS 트랜지션이 동작한다.
 * 필터·검색과 관계없이 전체 할 일 기준.
 */
function renderStats(stats) {
  const overall = percent(stats.done, stats.total);
  dom.statsOverallText.textContent = `${stats.done}/${stats.total} 완료 (${overall}%)`;
  dom.statsOverallBar.style.width = `${overall}%`;
  dom.statsOverallProgress.setAttribute('aria-valuenow', String(overall));
  dom.statsOverallProgress.setAttribute('aria-valuetext', `${stats.total}개 중 ${stats.done}개 완료, ${overall}%`);

  for (const [category, { total, done }] of Object.entries(stats.byCategory)) {
    const els = categoryStatEls[category];
    const p = percent(done, total);
    if (els.count) els.count.textContent = `${done}/${total}`;
    if (els.bar) els.bar.style.width = `${p}%`;
    if (els.progress) {
      els.progress.setAttribute('aria-valuenow', String(p));
      els.progress.setAttribute('aria-valuetext', `${total}개 중 ${done}개 완료`);
    }
  }

  dom.statsToday.textContent = String(stats.today);
  dom.cheer.textContent = cheerMessage(stats.done, stats.total);
}

/**
 * 상태 → 화면. 모든 상태 변경 후 호출한다.
 * 목록은 재조정(reconcile)으로 바뀐 부분만 반영하고, 나머지 영역은 텍스트·속성만 갱신한다.
 */
function render() {
  const visible = getVisibleTodos();
  const elements = visible.map(getTodoElement);
  reconcileList(elements);

  // 등장 애니메이션은 이번 렌더에서 한 번만 적용
  for (const [id, className] of entryAnimations) {
    const el = nodeCache.get(id)?.el;
    if (el?.isConnected) replayAnimation(el, className);
  }
  entryAnimations.clear();
  pruneNodeCache();

  dom.list.classList.toggle('is-manual', sortMode === 'manual');
  dom.list.setAttribute('aria-label', `할 일 목록, ${visible.length}개`);

  const stats = computeStats();
  renderEmptyState(visible.length);
  renderFilterButtons();
  renderBadge(stats.total - stats.done);
  renderClearButton(stats.done);
  renderUndoButton();
  renderStats(stats);
}

/** 1분마다: 상대 시간("N분 전")과 날짜가 바뀌었을 때의 통계만 갱신 */
function refreshTimes() {
  for (const { el } of nodeCache.values()) {
    const time = el.querySelector('.todo-item__time');
    if (!time) continue;
    const label = formatRelativeTime(time.dateTime);
    if (time.textContent !== label) time.textContent = label;
  }
  renderStats(computeStats());
}

// --- 오늘의 격언 ---

/** 날짜(로컬 기준)마다 같은 격언이 나오도록 하는 인덱스 */
function dailyQuoteIndex() {
  const localDays = Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
  return localDays % QUOTES.length;
}

function showQuote(index) {
  quoteIndex = index;
  const quote = QUOTES[index];
  dom.quoteText.textContent = `“${quote.text}”`;
  dom.quoteAuthor.textContent = `— ${quote.author}`;
}

/** 지금과 다른 격언을 무작위로 */
function showRandomQuote() {
  if (QUOTES.length < 2) return;
  let next;
  do {
    next = Math.floor(Math.random() * QUOTES.length);
  } while (next === quoteIndex);
  showQuote(next);
  replayAnimation(dom.quoteText, 'quote-change');
  announce(`${QUOTES[next].text} ${QUOTES[next].author}`);
}

// =============================================================================
// 13. 드래그 앤 드롭 (직접 정렬)
//
// HTML5 드래그 API는 터치에서 동작하지 않아 Pointer Events로 구현한다.
// - 손잡이(⋮⋮)를 누르면 목록(<ul>)이 포인터를 캡처한다. 움직이는 <li>에 캡처하면
//   DOM 위치를 옮길 때 캡처가 풀리는 브라우저가 있어 움직이지 않는 <ul>에 건다.
// - 포인터가 움직이면 다른 항목의 세로 중앙선을 기준으로 끌고 있는 <li>를 DOM에서 옮긴다.
//   계산은 requestAnimationFrame으로 프레임당 한 번만 한다.
// - 놓으면 DOM 순서를 읽어 상태에 반영하고, Esc나 pointercancel이면 원래 순서로 되돌린다.
// =============================================================================

function startDrag(e, handle) {
  if (drag || sortMode !== 'manual' || e.button !== 0) return;
  const li = handle.closest('.todo-item');
  if (!li || li.classList.contains('is-leaving')) return;

  e.preventDefault(); // 텍스트 선택, 터치 스크롤 방지
  try {
    dom.list.setPointerCapture(e.pointerId);
  } catch {
    // 캡처를 지원하지 않아도 같은 요소 위에서는 이벤트를 받을 수 있으므로 계속 진행
  }
  drag = { li, id: li.dataset.id, pointerId: e.pointerId, y: e.clientY, moved: false };
  li.classList.add('dragging');
  dom.list.classList.add('is-dragging');
  announce('끌기 시작. 놓을 위치로 이동한 뒤 놓으세요. Esc로 취소');
}

function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.y = e.clientY;
  if (!dragFrame) dragFrame = requestAnimationFrame(updateDragPosition);
}

function updateDragPosition() {
  dragFrame = 0;
  if (!drag) return;
  const { li, y } = drag;

  // 포인터보다 아래쪽에 중앙선이 있는 첫 항목 앞에 놓는다
  let before = null;
  for (const el of dom.list.children) {
    if (el === li) continue;
    const rect = el.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      before = el;
      break;
    }
  }
  const alreadyThere = before === null ? dom.list.lastElementChild === li : li.nextElementSibling === before;
  if (!alreadyThere) {
    dom.list.insertBefore(li, before);
    drag.moved = true;
  }

  // 화면 가장자리 근처면 자동 스크롤하고, 포인터가 멈춰 있어도 계속 스크롤되도록 다음 프레임 예약.
  // 위쪽 가장자리는 화면에 고정된 입력 영역(web_version 데스크톱)의 아래쪽 끝을 기준으로 한다.
  let scroll = 0;
  if (y < stickyHeaderBottom() + DRAG_EDGE_PX) scroll = -DRAG_SCROLL_STEP;
  else if (y > window.innerHeight - DRAG_EDGE_PX) scroll = DRAG_SCROLL_STEP;
  if (scroll !== 0) {
    window.scrollBy(0, scroll);
    dragFrame = requestAnimationFrame(updateDragPosition);
  }
}

/**
 * 화면 위에 고정(sticky)된 입력 영역이 있으면 그 아래쪽 끝의 y 좌표, 없으면 0.
 * 고정 영역 뒤로 가려진 항목 사이에 놓이지 않도록 드래그 자동 스크롤 기준선으로 쓴다.
 * (루트 버전처럼 .main__controls가 없거나 고정되지 않은 레이아웃에서는 0)
 */
function stickyHeaderBottom() {
  const controls = document.querySelector('.main__controls');
  if (!controls || getComputedStyle(controls).position !== 'sticky') return 0;
  return Math.max(0, controls.getBoundingClientRect().bottom);
}

/** @param {boolean} commit true면 새 순서를 저장, false면 원래 순서로 복원 */
function finishDrag(commit) {
  if (!drag) return;
  const { li, id, pointerId, moved } = drag;
  drag = null;
  cancelAnimationFrame(dragFrame);
  dragFrame = 0;
  try {
    if (dom.list.hasPointerCapture?.(pointerId)) dom.list.releasePointerCapture(pointerId);
  } catch {
    // 이미 해제된 경우 무시
  }
  li.classList.remove('dragging');
  dom.list.classList.remove('is-dragging');

  if (commit && moved) {
    const ids = [...dom.list.children].map((el) => el.dataset.id);
    reorderVisible(ids);
    announce(`${ids.length}개 중 ${ids.indexOf(id) + 1}번째로 이동`);
  } else {
    render(); // 상태는 그대로이므로 render가 DOM을 원래 순서로 돌려놓는다
    if (!commit) announce('이동 취소');
  }
  focusTodo(id, '.todo-item__handle');
}

// =============================================================================
// 14. 이벤트 연결
// =============================================================================

// form submit 하나로 Enter 키와 버튼 클릭을 모두 처리
dom.form.addEventListener('submit', (e) => {
  e.preventDefault();
  submitNewTodo();
});

dom.input.addEventListener('animationend', () => dom.input.classList.remove('shake'));

// 자동 카테고리 분류
dom.input.addEventListener('input', updateAutoCategory);
// 'change'는 사용자가 직접 골랐을 때만 발생한다 (코드에서 value를 바꿀 때는 발생하지 않음)
dom.categorySelect.addEventListener('change', () => {
  categoryTouched = true;
  baseCategory = dom.categorySelect.value;
  updateAutoCategory();
});
dom.categorySelect.addEventListener('animationend', () => dom.categorySelect.classList.remove('auto-picked'));
dom.autoCategoryToggle.addEventListener('change', () => setAutoCategoryEnabled(dom.autoCategoryToggle.checked));

dom.filterBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (btn) setFilter(btn.dataset.filter);
});

dom.searchInput.addEventListener('input', () => debouncedSearch(dom.searchInput.value));
// 검색창의 ✕(지우기) 버튼이나 Enter는 기다리지 않고 바로 반영
dom.searchInput.addEventListener('search', () => {
  debouncedSearch(dom.searchInput.value);
  debouncedSearch.flush();
});
dom.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && dom.searchInput.value) {
    e.preventDefault();
    dom.searchInput.value = '';
    debouncedSearch.cancel();
    setSearch('');
  }
});

dom.sortSelect.addEventListener('change', () => setSort(dom.sortSelect.value));
dom.undoBtn.addEventListener('click', undoLast);
dom.clearCompletedBtn.addEventListener('click', clearCompleted);
dom.themeToggle.addEventListener('click', toggleTheme);
dom.quoteNext.addEventListener('click', showRandomQuote);
dom.exportBtn.addEventListener('click', exportTodos);
dom.importBtn.addEventListener('click', () => dom.importFile.click());
dom.importFile.addEventListener('change', async () => {
  const file = dom.importFile.files?.[0];
  try {
    await importFromFile(file);
  } finally {
    // 같은 파일을 다시 선택해도 change가 발생하도록 비움
    dom.importFile.value = '';
  }
});

// 대화상자 바깥(배경)을 클릭하면 취소
for (const dialog of [dom.confirmDialog, dom.importDialog]) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close('cancel');
  });
}

// --- 목록 이벤트: 모두 #todo-list 하나에 위임 (항목 수와 관계없이 리스너 수 일정) ---

dom.list.addEventListener('click', async (e) => {
  const li = e.target.closest('.todo-item');
  if (!li || li.classList.contains('is-leaving')) return;

  if (e.target.closest('.todo-item__delete')) {
    await animateOut(li, 'fade-out');
    deleteTodo(li.dataset.id);
  } else if (e.target.closest('.todo-item__edit')) {
    startEdit(li.dataset.id);
  }
});

dom.list.addEventListener('change', async (e) => {
  if (!e.target.matches('.todo-item__checkbox')) return;
  const li = e.target.closest('.todo-item');
  if (li.classList.contains('is-leaving')) return;
  // 키보드(Space)로 토글했다면 이동한 위치에서도 포커스를 이어가야 함
  const refocus = document.activeElement === e.target;
  li.classList.toggle('completed', e.target.checked); // 슬라이드 중에도 취소선이 보이도록
  await animateOut(li, 'slide-out');
  toggleTodo(li.dataset.id, { refocus });
});

dom.list.addEventListener('dblclick', (e) => {
  const text = e.target.closest('.todo-item__text');
  if (text) startEdit(text.closest('.todo-item').dataset.id);
});

dom.list.addEventListener('keydown', (e) => {
  // 드래그 손잡이: ↑/↓로 순서 이동
  if (e.target.matches('.todo-item__handle') && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    moveTodoBy(e.target.closest('.todo-item').dataset.id, e.key === 'ArrowUp' ? -1 : 1);
    return;
  }

  // 인라인 편집기: Enter 저장, Esc 취소
  const editor = e.target.closest('.todo-edit');
  if (!editor) return;
  if (e.key === 'Enter' && !e.isComposing) {
    // isComposing: 한글 조합 중 Enter는 무시 (마지막 글자 중복 방지)
    e.preventDefault();
    commitFromEditor(editor, { refocus: true });
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    cancelEdit({ refocus: true });
  }
});

// 편집 영역 밖으로 포커스가 나가면 저장 (input ↔ select 이동은 제외).
// 사용자가 다른 곳을 클릭한 것이므로 포커스를 되돌리지 않는다.
dom.list.addEventListener('focusout', (e) => {
  const editor = e.target.closest('.todo-edit');
  if (!editor || editingId === null) return;
  if (editor.contains(e.relatedTarget)) return;
  commitFromEditor(editor);
});

// 드래그 앤 드롭
dom.list.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.todo-item__handle');
  if (handle) startDrag(e, handle);
});
dom.list.addEventListener('pointermove', onDragMove);
dom.list.addEventListener('pointerup', (e) => {
  if (drag && e.pointerId === drag.pointerId) finishDrag(true);
});
dom.list.addEventListener('pointercancel', (e) => {
  if (drag && e.pointerId === drag.pointerId) finishDrag(false);
});
dom.list.addEventListener('lostpointercapture', (e) => {
  // 캡처가 예기치 않게 풀린 경우의 안전장치
  if (drag && e.pointerId === drag.pointerId) finishDrag(true);
});

// --- 키보드 단축키 ---
// e.key 대신 e.code를 써서 한글 자판 상태에서도 동작한다 (한글 상태에서 N의 e.key는 'ㅜ').
document.addEventListener('keydown', (e) => {
  if (drag && e.key === 'Escape') {
    e.preventDefault();
    finishDrag(false);
    return;
  }
  if (drag || isAnyDialogOpen()) return;

  // Ctrl/⌘+Z: 되돌리기. 입력창에서는 브라우저의 글자 되돌리기를 방해하지 않는다.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyZ') {
    if (isTextField(e.target)) return;
    e.preventDefault();
    undoLast();
    return;
  }

  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

  const digit = /^(?:Digit|Numpad)([1-4])$/.exec(e.code);
  if (e.code === 'KeyN') {
    e.preventDefault();
    dom.input.focus();
    dom.input.select();
  } else if (e.code === 'KeyD') {
    e.preventDefault();
    toggleTheme();
  } else if (digit) {
    e.preventDefault();
    // 편집 중이면 먼저 포커스를 빼서 저장(focusout)한 뒤 필터 전환
    if (document.activeElement?.closest?.('.todo-edit')) document.activeElement.blur();
    setFilter(FILTERS[Number(digit[1]) - 1]);
  }
});

// --- 저장 시점 보장: 탭을 닫거나 숨길 때 대기 중인 저장을 즉시 실행 ---
window.addEventListener('pagehide', flushPendingSave);
window.addEventListener('beforeunload', flushPendingSave);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPendingSave();
});

// --- 다른 탭과 동기화 ---
window.addEventListener('storage', (e) => {
  if (e.storageArea !== localStorage) return;

  if (e.key === STORAGE_KEYS.theme && (e.newValue === 'dark' || e.newValue === 'light')) {
    applyTheme(e.newValue, { animate: true });
    return;
  }
  if (e.key !== STORAGE_KEYS.todos && e.key !== null) return; // null = 저장소 전체 삭제

  if (saveTodos.pending()) {
    // 이 탭에도 저장 전인 변경이 있으면 이 탭의 내용을 우선 저장한다 (마지막 작성자 우선)
    saveTodos.flush();
    showToast('다른 탭에서도 목록이 바뀌었습니다. 이 탭의 내용으로 저장했습니다.');
    return;
  }

  if (drag) finishDrag(false);
  todos = loadTodos();
  if (editingId !== null && !findTodo(editingId)) editingId = null;
  render();
  showToast('다른 탭에서 바뀐 내용을 불러왔습니다.');
});

// 저장된 테마가 없으면 운영체제 설정 변경을 따라간다
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', (e) => {
  if (readStorage(STORAGE_KEYS.theme)) return;
  applyTheme(e.matches ? 'dark' : 'light', { animate: true });
});

// --- 예상하지 못한 오류: 콘솔에 남기고 사용자에게 한 번 알린다 (5초에 한 번까지) ---
let lastErrorToast = 0;
function reportUnexpectedError(error) {
  console.error('예상치 못한 오류:', error);
  const now = Date.now();
  if (now - lastErrorToast < 5000) return;
  lastErrorToast = now;
  showToast('예상치 못한 오류가 발생했습니다. 문제가 계속되면 새로고침해 주세요.', { type: 'error' });
}
window.addEventListener('error', (e) => reportUnexpectedError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => reportUnexpectedError(e.reason));

// =============================================================================
// 15. 초기화
// =============================================================================

function init() {
  todos = loadTodos();
  currentFilter = loadChoice(STORAGE_KEYS.filter, FILTERS, 'all');
  sortMode = loadChoice(STORAGE_KEYS.sort, Object.keys(SORTS), DEFAULT_SORT);
  dom.sortSelect.value = sortMode;
  autoCategoryEnabled = readStorage(STORAGE_KEYS.autoCategory) !== 'off'; // 기본값: 켬
  dom.autoCategoryToggle.checked = autoCategoryEnabled;
  baseCategory = isCategory(dom.categorySelect.value) ? dom.categorySelect.value : DEFAULT_CATEGORY;

  applyTheme(getTheme());
  showQuote(dailyQuoteIndex());
  render();

  for (const message of startupWarnings) {
    showToast(message, { type: 'error', duration: 10000 });
  }

  setInterval(refreshTimes, 60 * 1000);
}

init();
