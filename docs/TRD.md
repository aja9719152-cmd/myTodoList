# TRD — My Tasks (기술 요구사항 · 설계 문서)

| 항목 | 내용 |
|---|---|
| 문서 종류 | 기술 요구사항 문서 (Technical Requirements Document) |
| 기준 버전 | 2026-11-11, 반응형 단일 버전 통합 완료 시점 |
| 관련 문서 | [PRD.md](PRD.md) (기능 요구사항), [TASKS.md](TASKS.md) (작업 목록), [../CLAUDE.md](../CLAUDE.md) (코드 작업 가이드) |

## 1. 기술 스택 · 제약

| 항목 | 결정 | 이유 |
|---|---|---|
| 언어 | HTML, CSS, JavaScript (프레임워크 없음) | 첫 요구사항: `index.html`, `style.css`, `script.js` 세 파일 구성 |
| 빌드 | 없음 | 파일을 더블클릭해서 바로 실행 |
| 저장소 | `localStorage` | 서버 없이 새로고침 후에도 데이터 유지 |
| 외부 의존성 | 없음 | 오프라인·`file://`에서도 동작 |
| 대상 브라우저 | 최신 Chrome / Edge / Firefox / Safari | `<dialog>`, `color-mix()`, `:has()`, Pointer Events, `Object.hasOwn` 사용 |

`<dialog>`를 지원하지 않는 환경에서는 `window.confirm`으로 대신한다.

## 2. 파일 구조

```
todolist/
├── index.html    # 마크업: 3개 패널 + 대화상자 2개 + 알림 영역
├── style.css     # 테마 토큰, 컴포넌트, 반응형 레이아웃(파일 끝 "데스크톱 레이아웃")
├── script.js     # 모든 동작 (번호가 붙은 15개 섹션)
├── CLAUDE.md     # 코드 작업 가이드
├── docs/         # PRD, TRD, TASKS
└── win.png       # 참고 스크린샷 (예전 1단 레이아웃을 넓은 화면에서 본 모습)
```

### 2.1 `script.js` 섹션

| # | 섹션 | 주요 내용 |
|---|---|---|
| 1 | 상수 | 저장 키, 카테고리, 정렬, 제한값, 격언, 키워드 |
| 2 | DOM 참조 | `requireElement()`가 id가 없으면 바로 오류를 냄 |
| 3 | 상태 | 저장되는 상태 / 화면 전용 상태 |
| 4 | 유틸리티 | `debounce`, `normalizeText`, `formatRelativeTime` 등 |
| 5 | 저장소 | 읽기/쓰기, `sanitizeTodo`, 손상 데이터 백업 |
| 6 | 필터·정렬 | `isVisible`, `sortForDisplay`, `getVisibleTodos` |
| 6-1 | 키워드 자동 분류 | `classifyText`, 드롭다운 자동 선택 |
| 7 | 할 일 조작 | 추가·삭제·토글·수정·순서 변경·필터·검색 |
| 8 | 되돌리기 | `pushUndo`, `runUndo`, `undoLast` |
| 9 | 내보내기·가져오기 | 파일 검증, 합치기/바꾸기 |
| 10 | 테마 | `applyTheme`, `toggleTheme` |
| 11 | 피드백 | 스크린 리더 알림, 토스트, 대화상자, 애니메이션, 포커스 |
| 12 | 렌더링 | 키 기반 재조정, 통계, 빈 상태 |
| 13 | 드래그 앤 드롭 | Pointer Events 기반 |
| 14 | 이벤트 연결 | 이벤트 위임, 단축키, 탭 동기화, 전역 오류 |
| 15 | 초기화 | `init()` |

## 3. 데이터 모델

### 3.1 할 일 (Todo)

```ts
{
  id: string,          // crypto.randomUUID() (없으면 시간+난수)
  text: string,        // 1~200자, 앞뒤 공백 제거
  completed: boolean,
  createdAt: string,   // ISO 8601
  category: 'work' | 'personal' | 'study'
}
```

- `todos` 배열의 순서가 곧 "직접 정렬" 순서다. 다른 정렬 방식은 화면에 그릴 때만 순서를 바꾸고, 배열 자체는 바꾸지 않는다.
- 저장소나 파일에서 들어온 값은 모두 `sanitizeTodo` / `sanitizeTodoList`를 거친다.
  - 내용이 없는 항목은 버린다.
  - 잘못되었거나 빠진 필드는 보정한다. category가 없으면 `personal`, 날짜가 잘못되었으면 현재 시각을 넣는다.
  - 중복된 id는 새 id로 바꾼다.

### 3.2 localStorage 키

| 키 | 값 | 비고 |
|---|---|---|
| `todos` | Todo[] (JSON) | 디바운스 저장 |
| `todoFilter` | `all` / `work` / `personal` / `study` | |
| `todoSort` | `status` / `manual` / `newest` / `oldest` / `category` | 기본 `status` |
| `todoTheme` | `light` / `dark` | `index.html` `<head>`의 인라인 스크립트도 직접 읽음 |
| `todoAutoCategory` | `on` / `off` | 기본 켬 |
| `todos_corrupted_backup` | 원본 문자열 | 손상 데이터를 발견했을 때만 기록 |

### 3.3 내보내기 파일 형식

```json
{ "format": "my-tasks", "version": 1, "exportedAt": "ISO 8601", "todos": [ ... ] }
```

가져오기는 이 형식과 할 일 배열만 있는 JSON을 모두 받는다. `format`이 다르거나 `version`이 현재보다 높으면 거절한다.

## 4. 핵심 설계

### 4.1 상태 → 화면 흐름

```
사용자 조작 → 상태 변경 → saveTodos() (300ms 디바운스) → render()
```

`render()`가 하는 일은 다음과 같다.

1. `getVisibleTodos()`로 보일 항목을 고른다. 필터·검색을 적용한 뒤 정렬한다.
2. `getTodoElement()`로 항목별 `<li>`를 가져온다. 내용이 같으면 캐시된 것을 재사용한다.
3. `reconcileList()`로 바뀐 부분만 화면에 반영한다.
4. 한 번만 재생할 등장 애니메이션(`entryAnimations`)을 적용한다.
5. 통계는 `computeStats()` 한 번으로 계산해 배지·대시보드·버튼에 나눠준다.

### 4.2 키 기반 재조정 (성능)

- `nodeCache`는 id별로 `{ el, sig, query }`를 보관한다. `sig`는 화면에 영향을 주는 값(텍스트·완료·카테고리·생성시각·편집 여부)을 이어 붙인 서명이다.
- 서명이 같으면 기존 `<li>`를 그대로 쓴다. 검색어만 바뀌었으면 텍스트 하이라이트만 다시 그린다.
- `reconcileList()`는 두 단계로 동작한다.
  1. 화면에서 빠질 노드를 먼저 제거한다.
  2. 앞에서부터 비교한다. 노드 하나만 제자리를 벗어난 경우에는 그 노드만 맨 뒤로 보낸다.
- 그래서 항목 하나가 이동하면 DOM 이동도 한 번만 일어난다.
- 측정 결과(jsdom, 300개, 완료 체크 20번): 1067ms → 293ms. 고치기 전에는 항목 하나를 체크할 때 그 아래 항목이 전부 옮겨졌다.
- 이벤트는 목록(`#todo-list`) 하나에 위임한다. 항목 수와 관계없이 리스너 수는 일정하다.

### 4.3 애니메이션

- **등장:** `entryAnimations`(id → 클래스)를 `render()`가 한 번만 적용한다. 항목 `<li>`를 재사용하기 때문에 클래스를 그냥 붙여 두면 다시 그릴 때마다 반복 재생된다.
- **퇴장:** `animateOut()`이 `animationend`를 기다린다. 이벤트가 오지 않을 때를 대비해 400ms 타이머도 건다. 애니메이션이 끝난 뒤에 상태를 바꾸고, `.is-leaving` 클래스로 두 번 클릭을 막는다.
- **reflow 최소화:** `replayAnimation()`은 클래스가 이미 있을 때만 강제 reflow를 한다. 수백 개를 한꺼번에 가져올 때 reflow가 반복되지 않게 하기 위해서다.

### 4.4 되돌리기

- 되돌릴 수 있는 작업은 `pushUndo(label, fn)`로 기록한다. 최대 20개까지 쌓이고 오래된 것부터 버린다.
- Ctrl+Z와 ↶ 버튼은 가장 최근 작업을 되돌린다. 알림의 "되돌리기"는 그 알림이 가리키는 작업만 되돌린다.
- **삭제:** `{ todo, index }`를 index 오름차순으로 다시 넣어 원래 자리로 복원한다.
- **가져오기(바꾸기):** 이전 상태를 깊은 복사로 보관해 둔다. 완료 토글이 할 일 객체를 직접 바꾸기 때문이다.

### 4.5 인라인 편집

- `commitEdit(id, …)`는 `editingId === id`일 때만 저장한다. 그리고 다시 그리기 **전에** `editingId`를 비운다.
- 이유: 포커스가 있는 편집기를 DOM에서 지우면 `focusout`이 발생하는데, 이 순서를 지키지 않으면 같은 내용이 두 번 저장되거나 다른 항목에 저장된다.
- 한글 조합 중에 누른 Enter(`e.isComposing`)는 무시한다. 마지막 글자가 중복 입력되는 것을 막기 위해서다.

### 4.6 키워드 자동 분류 알고리즘

1. 텍스트를 소문자로 바꾸고 공백을 정리한다.
2. 키워드를 길이가 긴 것부터 찾는다.
   - 한국어는 부분 문자열로 찾는다. "회의를"처럼 조사가 붙기 때문이다.
   - 영어는 단어 경계(`\b`)로 찾는다.
3. 이미 다른 키워드가 차지한 글자와 겹치는 매치는 버린다.
4. 카테고리별 매치 수로 점수를 매긴다. 동점이면 가장 뒤에서 끝나는 매치가 있는 카테고리를 고른다(한국어는 핵심 명사가 뒤에 옴).

UI 상태는 두 가지다.

- `categoryTouched`: 사용자가 드롭다운을 직접 골랐는지. 할 일을 추가하면 초기화된다.
- `baseCategory`: 사용자가 마지막으로 직접 고른 값. 키워드가 없을 때 이 값으로 돌아간다.

성능: 180자 문장 1000번 분류에 57ms(jsdom).

### 4.7 드래그 앤 드롭

- HTML5 드래그 API는 터치에서 동작하지 않아서 Pointer Events로 구현했다.
- 포인터 캡처는 움직이는 `<li>`가 아니라 `<ul>`에 건다. 노드를 옮길 때 캡처가 풀리는 브라우저가 있기 때문이다.
- 포인터가 움직이면 다른 항목의 세로 중앙선을 기준으로 끌고 있는 `<li>`를 DOM에서 실시간으로 옮긴다. 계산은 `requestAnimationFrame`으로 프레임당 한 번만 한다.
- 놓으면 DOM 순서를 `reorderVisible()`에 넘긴다. 이 함수는 화면에 보이는 항목들이 배열에서 차지하던 자리만 다시 채우므로, 필터·검색으로 숨겨진 항목의 위치는 바뀌지 않는다.
- 화면 끝 60px 안에서는 자동 스크롤한다. 위쪽 기준선은 화면에 고정된 입력 영역의 아래 끝(`stickyHeaderBottom()`)이다.
- 키보드로는 손잡이에서 ↑/↓ 키(`moveTodoBy`)로 옮긴다.

### 4.8 가져오기 처리 순서

```
파일 선택 → 크기(5MB)·확장자 확인 → 읽기 → JSON 파싱 → 형식·버전 확인
→ sanitizeTodoList → (현재 데이터가 있으면) 방식·백업 선택 대화상자
→ 백업 다운로드 (실패하면 중단) → applyImport (합치기: 같은 id는 건너뜀)
→ 되돌리기 기록 + 결과 알림
```

## 5. 화면 · 스타일

### 5.1 테마

- 색은 모두 `:root`와 `:root[data-theme="dark"]`의 CSS 변수(토큰)로 정의한다. 색을 직접 쓰면 다크 모드가 깨진다.
- 테마를 바꾸는 동안 0.4초만 `.theme-transition` 클래스를 붙여 모든 요소에 색 전환을 건다. 평소에는 다른 트랜지션과 섞이지 않는다.
- 카테고리 색은 `--accent`로 전달한다. 다크 배경에서 글자로 쓸 때는 밝게 섞은 `--accent-text`를 쓴다(보라색 #8E44AD의 대비 문제).

### 5.2 반응형 레이아웃

- `index.html`은 화면을 세 패널로 나눈다.
  - `.panel--nav`: 제목, 테마, 필터, 단축키
  - `.panel--insights`: 격언, 진행률
  - `.panel--main`: 화면 위에 고정되는 `.main__controls`(입력·검색), 그 아래 목록과 작업 버튼
- `style.css` 끝의 "데스크톱 레이아웃" 부분이 CSS Grid로 패널을 배치한다. 너비별 구성은 PRD N1 참고.
- 목록에 별도 스크롤 영역을 두지 않고 페이지 자체가 스크롤된다. 드래그 자동 스크롤이 `window.scrollBy`를 쓰기 때문이다.
- 1024px 이상에서는 `html { scroll-padding-top: 240px }`을 둔다. 고정 영역(약 183px)보다 커야 키보드 포커스가 그 뒤로 가려지지 않는다.

### 5.3 접근성 구현

| 항목 | 구현 |
|---|---|
| 스크린 리더 알림 | 화면에 보이지 않는 `#sr-status`(`role="status"`)에 `announce()`로 기록 |
| 토스트 | `aria-live="polite"` 영역, 오류는 `role="alert"` |
| 진행률 | `role="progressbar"` + `aria-valuetext` ("10개 중 5개 완료") |
| 대화상자 | `<dialog>` 모달. 닫히면 연 요소로 포커스 복귀 |
| 포커스 이동 | `focusTodo(id, selector)`로 다시 그린 뒤 포커스 유지 |
| 단축키 | `e.code`로 처리해 한글 입력 상태에서도 동작 |

## 6. 오류 처리

| 상황 | 처리 |
|---|---|
| localStorage 접근 불가 | `readStorage`/`writeStorage`가 예외를 잡음. 앱은 메모리만으로 계속 동작 |
| 저장 실패(용량 등) | 실패 상태로 바뀔 때 한 번만 경고. 다시 정상이 되면 알림 |
| 저장 데이터 손상 | `todos_corrupted_backup`에 원본 보관 → 빈 목록으로 시작 → 시작 후 알림 |
| 다른 탭에서 변경 | `storage` 이벤트로 다시 불러옴. 이 탭에 저장 전인 변경이 있으면 이 탭 내용을 저장(마지막 작성자 우선) |
| 애니메이션 중 항목이 사라짐 | 다시 그려서 흐려진 노드 정리 |
| index.html에 필요한 id 없음 | `requireElement()`가 원인을 알려주는 오류 발생 |
| 예상하지 못한 오류 | `error`/`unhandledrejection` → 콘솔 기록 + 알림(5초에 한 번까지) |

## 7. 주요 설정값

| 상수 | 값 |
|---|---|
| `MAX_TEXT_LENGTH` | 200자 |
| `MAX_IMPORT_BYTES` | 5MB |
| `MAX_UNDO` | 20 |
| `SAVE_DEBOUNCE_MS` | 300ms |
| `SEARCH_DEBOUNCE_MS` | 150ms |
| `ANIMATION_FALLBACK_MS` | 400ms |
| `TOAST_MS` / `MAX_TOASTS` | 5000ms / 3개 |
| `DRAG_EDGE_PX` / `DRAG_SCROLL_STEP` | 60px / 12px |
| `EXPORT_FORMAT` / `EXPORT_VERSION` | `my-tasks` / 1 |

## 8. 검증 방법

저장소에 자동화 테스트는 없다. 개발 중에는 다음 방식으로 확인했다.

- **문법:** `node --check script.js`
- **기능 (jsdom):**
  - `index.html`을 불러오고 `script.js`를 `<script>` 요소로 넣어 실행했다. 파일이 `'use strict'`라서 `window.eval`로 실행하면 최상위 함수에 접근할 수 없다.
  - `showModal`, `URL.createObjectURL`, `scrollBy`는 jsdom에 없어서 가짜로 대신했다.
  - 삭제·완료 후에는 약 0.4초, 저장 확인 전에는 0.3초를 기다려야 한다.
  - 검증한 범위: 손상 데이터, 중복, 정렬 5종, 드래그·키보드 순서 변경, 되돌리기, 수정, 내보내기, 잘못된 가져오기 8가지, 합치기·바꾸기, 검색, 탭 동기화, XSS, 300개 성능, 자동 분류 24가지
- **화면 (헤드리스 Chrome):**
  - 샘플 데이터를 넣은 임시 복사본을 1700/1280/1920/820px, 라이트·다크로 찍었다. 스크롤 후 고정 요소 위치는 `--dump-dom`으로 측정했다.
  - 촬영 시 주의점:
    - 전환 효과가 끝나도록 `--virtual-time-budget`을 줘야 한다.
    - Windows Chrome은 창의 최소 너비 때문에 480px 이하를 재현할 수 없다.
    - 스크롤한 뒤 찍은 스크린샷은 위치가 어긋나므로 측정값으로 확인한다.
