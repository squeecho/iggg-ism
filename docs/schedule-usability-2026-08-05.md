# 통합일정표 사용성 개선 갭 스코어보드

- 기준일: 2026-08-05
- 기준 커밋: `292be05cbea19915eb68799faf25e1ecd49f79d9`
- 작업 브랜치: `feat/schedule-usability-20260805`
- 범위: 직원 요청 6건의 데이터 정확성, 일정 편집, 차트 가독성
- 안전 경계: 운영 Firebase, Google Calendar, 고객 데이터, 기존 사용자 브라우저 저장소에 접근하거나 변경하지 않는다.

## 저장 및 실행 흐름 기준선

| 영역 | 현재 정본/진입점 | 확인 결과 |
|---|---|---|
| 현재 화면 상태 | `index.html:1658`의 `S`/`defaultState()` | 공종은 `tasks[]`, 특별 날짜는 `notes[]`에 저장한다. |
| 로컬 현장 | `index.html:1697-1700`, `1812-1915`, `2804-2855` | `cs_recent` 한 배열에 진행/보관 현장이 함께 있고 `snap: JSON.stringify(S)`로 전체 상태를 저장한다. |
| 클라우드 현장 | `index.html:2579-2746`, `5758-5928` | Firestore `sites` 문서에 상태 전체를 저장한다. 로드 경로마다 정규화가 일관되지 않다. |
| 공사기간 편집 | `index.html:3033-3104` | 달력 선택에서 첫 클릭은 즉시 기간과 모든 공종을 이동하고, 둘째 클릭은 다시 자동배치한다. 기간 변경 정책이 여러 함수에 분산돼 있다. |
| 공종 분할 | `index.html:3187-3567`, `3710-4119`, `4404-4477` | `sd/ed`, `sd2/ed2`, `sd3/ed3`를 화면별로 직접 분기한다. 공통 phase/range 정본이 없다. |
| 자동배치 | `index.html:2915-3032`, `7653-9650` | 기본 자동배치와 최적화 자동배치가 고정 공종/최대 3차를 전제한다. 자동/수동 일정 상태가 저장되지 않는다. |
| 통합 일정 | `index.html:6035-7630` | 고정 공종 목록과 1~3차 직접 분기가 중복된다. |
| Google Calendar | `index.html:5141-5270`, `5451-5467` | 상세 이벤트와 변경 해시가 3차도 누락한다. 4·5차 확장 시 공통 range 없이는 추가 누락된다. |
| 특별 날짜 | `index.html:1644-1654`, `3581-3944` | `type`과 `dt` 유무로 자동/수동을 암묵 판정하며 일부 항목만 3초 long-press로 수정 가능하다. |
| 차트 | `index.html:609-619`, `3695-4119` | 막대 끝 경계와 선택 가이드가 없고 1차와 3차가 같은 세로 위치에 겹친다. |

## 갭 스코어보드

상태 값: `parity` 충족, `partial` 일부 충족, `deviant` 의도와 다른 구현, `missing` 미구현, `oos` 이번 범위 밖.

| ID | 목표 | 상태 | 우선순위 | 코드 근거 | 구현/검증 기준 |
|---|---|---:|---:|---|---|
| W1-01 | 확정 해제 후 기간 변경 시 자동 공종만 즉시 재배치 | parity | P0 | `index.html`의 `setProjectPeriod`, `autoTaskDates`; `schedule-core.js`의 `applyConstructionPeriod` | phase별 자동/수동 표식을 저장하고 legacy는 이전 자동 결과와 일치할 때만 자동으로 추론한다. |
| W1-02 | 기간 선택을 원자적으로 적용 | parity | P0 | `index.html`의 `calClick`, `_cPendingSd` | 첫 날짜는 pending 상태에만 두고 둘째 날짜 선택 시 한 번만 기간과 공종을 반영한다. |
| W1-03 | 로컬 진행·보관·클라우드 전체의 정규화 현장명 중복 차단 | parity | P0 | `schedule-core.js`의 `canonicalSiteName`, `findSiteNameConflict`; `index.html`의 `_ensureCloudInventory` | NFKC, trim, 연속 공백 축약, 대소문자 정규화를 한 helper로 처리하며 cloud inventory 미확인 시 저장을 차단한다. |
| W1-04 | 신규 생성 시 기존 현장 덮어쓰기 제거 | parity | P0 | `index.html`의 `pnBtnClick`, `_showConflictModal`, `saveToCloud` | 덮어쓰기 확인창을 제거하고 기존 현장 열기/이름 변경만 제공한다. 문서 키 조회 실패와 충돌은 fail-closed다. |
| W1-05 | rename/save 회귀 방지 | parity | P1 | `index.html`의 `renameProject`, `_cloudEditSave` | 현재 현장을 제외해 검사하고 새 cloud 저장 성공 후 이전 키를 삭제한다. 이전 키 삭제 실패 시 새 키를 정리하고 편집 상태를 유지한다. |
| W1-06 | 이름 입력 중 autosave가 동명 현장을 덮어쓰지 않음 | parity | P0 | `schedule-core.js`의 `snapshotForIdentity`, `updateLocalDraft`; `index.html`의 `_persistCurrentLocalDraft` | autosave, unload, 현장 전환 모두 `_origPn` identity로만 현재 draft를 저장한다. |
| W2-01 | 기본 1차, 명시적 추가로 최대 5차 | parity | P0 | `schedule-core.js`의 `addTaskPhase`, `removeLastTaskPhase`; `index.html`의 `addTaskPhase`, `removeTaskPhase` | 기존 flat 필드를 유지하고 4·5차 필드를 추가했다. 마지막 차수부터만 제거하며 저장된 2·3차를 정규화해 보존한다. |
| W2-02 | phase 이름·기간 독립 편집 | parity | P0 | `schedule-core.js`의 `phaseFields`, `updateTaskPhase`; `index.html`의 `_phaseEditorHtml`, `openTCal` | `name2`~`name5`와 날짜·설명·모드를 독립 저장하며 없는 legacy 이름은 기본 공종명으로 fallback한다. |
| W2-03 | 모든 소비 경로가 1~5차를 포함 | parity | P0 | `schedule-core.js`의 `getTaskPhases`, `getTaskRanges`; `index.html`의 `rG`, `_gcalDoUpload`, `rIntegrated`, `asRunSchedule` | 공통 phase/range helper를 차트, 충돌, 통합 일정, 자동배치, 내보내기, Calendar에 적용했다. 자동배치 업체 후보도 5차 전체 슬롯을 통과해야 선택한다. |
| W2-04 | 통합 일정 3차 수정이 1차를 덮는 기존 결함 제거 | parity | P0 | `index.html`의 `igOpenBarModal`, `igBarpickSave`, `ctorCheckResolve` | 통합 막대와 업체 충돌 해결 모두 차수 인덱스를 공통 setter에 전달한다. 2~5차 충돌 행도 고유 ID를 사용한다. |
| W2-05 | 사용자 공종 CRUD 및 저장 | parity | P0 | `schedule-core.js`의 `createCustomTask`, `deleteCustomTask`, `orderedTaskIds`; `index.html`의 `addCustomTask`, `deleteCustomTaskConfirm` | 충돌 검사한 안전정수 ID와 `custom:true`를 저장한다. 기본 공종 삭제는 거부하고 동적 공종 목록을 전 경로에 포함했다. |
| W2-06 | 특별 날짜 자동/수동 토글 | parity | P0 | `schedule-core.js`의 `setNoteMode`, `getNoteDate`; `index.html`의 `rNE`, `setNoteModeUi`, `openNCal` | 명시적 `dateMode`를 도입했다. 직접 선택은 수동, 자동 복귀는 즉시 재계산하며 기간 밖 수동 날짜는 경고만 표시한다. 자동 규칙이 없는 사용자 항목은 수동만 제공한다. |
| W2-07 | 기존 저장 데이터 무손실 정규화 | parity | P0 | `schedule-core.js`의 `normalizeTask`, `normalizeNote`, `normalizeScheduleState`; `index.html`의 local/cloud/hash load 경로 | 모든 상태 진입점에서 같은 정규화를 호출하고 기존 2·3차 flat 필드와 특별 날짜 의미를 보존한다. |
| W3-01 | 모든 공종 막대 좌우 끝 경계 | missing | P1 | `index.html:609-619`, `327-344` | 막대 크기를 바꾸지 않는 inset 경계선을 기본/통합 차트에 적용한다. |
| W3-02 | 선택/드래그 중 시작·종료 세로 가이드 | missing | P1 | `index.html:3695-4119` | 포인터 이벤트 없는 전용 레이어를 막대 뒤에 두고 선택 해제/Escape를 지원한다. 인쇄·PDF에는 포함하지 않는다. |
| W3-03 | 1~5차 막대 겹침 방지 | parity | P0 | `index.html`의 `rG`, `renderOneMonth` | 메인 차트 행과 통합 달력 주 높이를 활성 phase/lane 수에 맞춰 계산한다. 5개 막대가 셀 안에 포함되는지 격리 DOM 좌표로 검증했다. |
| QA-01 | 기존 데이터 정규화와 저장/재로드 자동 테스트 | parity | P0 | `tests/schedule-core.test.js` | Node 기본 test runner로 순수 helper의 1~5차, legacy, 사용자 공종, 날짜 모드를 검증한다. |
| QA-02 | 격리 브라우저 실제 UI 검증 | parity | P0 | `tests/ui_regression.py` | 임시 브라우저 프로필과 합성 localStorage만 사용하고 외부 mutation을 차단한다. console/page error 및 mutation 0건을 테스트 종료 조건으로 둔다. |
| QA-03 | 데스크톱·모바일 시각 검증 | missing | P1 | 차트 1·3차 겹침 재현됨 | 1440px와 390px 화면을 캡처해 직접 확인한다. |
| OPS-01 | push/preview/운영 배포 | oos | - | 사용자 금지 범위 | 로컬 브랜치와 커밋만 생성한다. |

## 구현 원칙

1. 기존 flat phase 저장 형식을 정본으로 유지한다. 1차는 `sd/ed/name/desc`, 2~5차는 `splitN/sdN/edN/nameN/descN`을 사용한다.
2. 기존 값이 없는 `name2`~`name5`는 읽을 때 기본 `name`으로 fallback하며, 기존 필드를 삭제하거나 배열 정본을 병행 생성하지 않는다.
3. 사용자 공종 ID는 기존 숫자 기반 inline handler와의 호환을 위해 충돌 검사한 JavaScript 안전정수를 사용하고 `custom:true`로 삭제 가능 여부를 판정한다.
4. 표식이 없는 legacy 공종 일정은 기존 값을 우선 보존한다. 현재 공사기간 기준 자동 결과와 정확히 일치하는 범위만 자동으로 추론하고, 나머지는 수동으로 정규화한다.
5. 신규 현장은 1차만 보이며 자동 일정으로 시작한다. 자동배치는 이미 존재하는 phase 수를 임의로 늘리지 않는다.
6. 특별 날짜는 `dateMode: 'auto' | 'manual'`을 정본으로 추가하고 기존 `type`/`dt` 의미를 읽을 때만 호환한다.
7. 운영 연동은 검증 중 모두 차단한다. UI 검증은 합성 현장만 사용하며 Firebase/Calendar 쓰기 요청이 관측되면 실패로 처리한다.
8. 클라우드 자동 복구(`index.html:5930-5953`)도 같은 현장명 정규화 helper를 사용해 local 우선으로 병합한다.

## Wave 및 완료 게이트

| Wave | 변경 범위 | 완료 게이트 |
|---|---|---|
| 1 | W1-01~W1-05 | 기간 변경 자동/수동 회귀, local/cloud 정규화 충돌, rename/save 테스트 통과 후 별도 커밋 |
| 2 | W2-01~W2-07 | 1~5차 CRUD/저장/재로드/전 소비 경로, 사용자 공종 CRUD, 특별 날짜 자동/수동 테스트 통과 후 별도 커밋 |
| 3 | W3-01~W3-03 | 데스크톱/모바일 차트 실제 렌더, 선택/드래그 가이드, overlap 검사 통과 후 별도 커밋 |

## Wave 1 체크포인트

- 순수 회귀: Node test 7건 통과(이름 정규화/로컬·보관·cloud 충돌, pending rename identity, legacy 원문 identity, 기존 `split` 2차, 자동·수동 기간 재배치, legacy 추론, 단축 기간 clamp).
- 격리 UI: 실제 확정 해제 버튼과 기간 달력을 조작해 `2026-08-10 ~ 2026-09-10`을 적용했다. 자동 공종은 새 기간 안으로 이동했고 수동 공종은 `2026-07-20`에 고정됐다. 수동 타일이 종료일에 끝나는 경계에서도 자동 전기·공조 2차의 날짜 역전이 없었다.
- 저장 안전성: `Site A` 편집 중 `Site B`를 입력하고 debounce를 기다린 뒤 `Site B`의 합성 marker가 유지됨을 확인했다.
- 전역 중복: cloud 합성 이름 `ＳＥＯＵＬ　Site`와 입력 `seoul site`의 충돌을 차단하고 기존 현장 열기/이름 변경 동작만 노출했다.
- 네트워크: 새 incognito context에서 Calendar config 1건은 route로 합성 응답했고, 외부로 통과한 mutation 0건, console error 0건, page error 0건이었다.
- 입력 무변경: 자동 막대에서 mouse down/up만 수행한 경우 `scheduleMode: auto`가 수동으로 바뀌지 않음을 확인했다.
- 확정 전환 안전성: cloud 삭제 실패 시 확정 잠금을 유지하며, cloud 저장 실패 시 미확정 상태를 유지하고 정리 삭제를 호출하지 않음을 확인했다.
- 비동기 저장 안전성: 확정 해제의 지연된 cloud 삭제 사이에 다른 현장을 저장해도 최신 local snap이 되돌아가지 않음을 확인했다.
- 이름 변경 회귀: `Site A`를 `site a`로 변경하는 정규화 동등 self-rename은 허용하되, 다른 local/cloud 현장과의 동등 이름은 신규·마스터 편집 모두 차단했다.

## Wave 2 체크포인트

- 순수 회귀: Node test 15건이 통과했다. legacy 1~3차 정규화, 5차까지의 순차 추가·마지막 차수 제거, 사용자 공종 ID 충돌 방지·저장/재로드·삭제 보호, 특별 날짜 자동/수동 및 기간 밖 보존을 포함한다.
- 실제 편집 UI: 기본 1차에서 버튼을 네 번 눌러 5차까지 확장하고 5차 제거·재추가, 4차 이름·설명·기간 편집을 수행했다. 다른 합성 현장을 열었다 돌아온 뒤에도 5차와 4차 값이 유지됐다.
- 사용자 공종: 합성 사용자 공종을 추가해 이름·설명·2차·업체·활성 상태를 편집했다. 로컬 재로드 후 값이 유지되고 확인 모달 삭제 후 다시 재로드해도 복원되지 않았다.
- 최초 저장·클라우드 복원: 등록 전 편집한 2차와 사용자 공종이 첫 로컬 저장에서 유지됐다. Firestore의 최상위 상태 형식을 합성해 로컬 캐시가 없는 복원을 실행한 뒤 5차 이름과 사용자 공종이 직렬화된 `snap`에서 다시 열렸다.
- 특별 날짜: 간판실측 가능일을 수동으로 전환해 공사기간 밖 `2026-09-30`을 선택했다. 기간 변경 뒤 수동 날짜와 수동 4차는 고정됐고 자동 주방실측 날짜는 새 기간에 따라 이동했다. 자동 복귀도 즉시 반영됐다.
- 소비 경로: 메인 차트의 5개 막대, 통합 달력 한 날짜의 5개 막대와 셀 내부 포함, 자동배치 결과 5개 range, Google Calendar 상세 이벤트 5건과 5차 표기를 확인했다. 간략 Calendar 이벤트도 공사기간 밖 5차 종료일까지 확장됐다.
- 자동배치: 첫 업체가 4차 이후 합성 확정 일정과 충돌할 때 1~5차 전체가 가능한 두 번째 업체를 선택했다. 서로 다른 ID의 사용자 공종도 같은 업체가 겹치면 충돌로 판정했다. 준공청소 1~5차는 전기·공조 후처리가 끝난 최종일 이후 순차 배치됐다.
- 변경 가시성: 자동배치 결과의 원본 1~5차를 별도로 보존하고 4차만 달라진 합성 결과에서도 변경 표식과 `무시` 버튼이 나타나는지 확인했다. 무시는 기존 날짜와 자동/수동 mode를 모두 보존한다.
- 기간 재배치: 새 사용자 공종 1차는 직접 날짜를 고르기 전까지 자동 mode이며 기존 7일 기간을 보존해 새 공사 시작일로 이동했다. 준공청소 5개 자동 차수도 새 종료일까지 서로 겹치지 않고 순서대로 재배치됐다.
- 충돌 판정: 협력업체 충돌 해결에서 4차만 이동·복구되고 1차는 바뀌지 않음을 실제 모달로 확인했다.
- 네트워크·오류: 격리 Chromium에서 외부 mutation 0건, console error 0건, page error 0건이었다. 운영 Firebase, Google Calendar, 고객 데이터와 기존 사용자 저장소는 사용하지 않았다.

## 범위 밖 백로그

- Firebase/Google Calendar 운영 데이터 정리 또는 스키마 변경
- SSO/권한/배포 구조 변경
- 기존 서비스 계정 파일과 자격증명 정리
- 캘린더 API 인증·감사 이슈 수정
- 모놀리식 `index.html` 전면 모듈화
