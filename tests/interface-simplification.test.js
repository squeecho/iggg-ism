'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');

test('편집 상세 영역은 기본 접힘이며 키보드 토글 계약을 제공한다', () => {
  for (const [headerId, bodyId, arrowId] of [
    ['taskScheduleHeader', 'taskScheduleBody', 'taskScheduleArrow'],
    ['noteScheduleHeader', 'noteScheduleBody', 'noteScheduleArrow'],
  ]) {
    assert.match(
      html,
      new RegExp(`id="${headerId}"[^>]*role="button"[^>]*tabindex="0"[^>]*aria-expanded="false"[^>]*aria-controls="${bodyId}"`),
    );
    assert.match(html, new RegExp(`id="${bodyId}" style="display:none;`));
    assert.match(html, new RegExp(`id="${arrowId}"`));
  }
  assert.match(html, /function editSectionKeydown\(event,bodyId,arrowId,header\)/);
});

test('편집 화면 저장 카드는 기존 차트 PDF·이미지 exporter를 재사용한다', () => {
  assert.match(html, /id="editExportCard"/);
  assert.match(html, /id="editPdfBtn"[^>]*exportScheduleFromEdit\('pdf'\)/);
  assert.match(html, /id="editImgBtn"[^>]*exportScheduleFromEdit\('image'\)/);

  const start = html.indexOf('async function exportScheduleFromEdit(kind)');
  const end = html.indexOf('async function doIMG()', start);
  assert.ok(start >= 0 && end > start);
  const wrapper = html.slice(start, end);
  assert.match(wrapper, /await doPDF\(\)/);
  assert.match(wrapper, /await doIMG\(\)/);
  assert.doesNotMatch(wrapper, /html2canvas|new jsPDF/);
});

test('차트 협력업체 버튼과 통합 탭은 화면에서 숨긴다', () => {
  assert.match(html, /id="btnCtorCheck"[^>]*style="display:none"[^>]*aria-hidden="true"/);
  assert.match(html, /id="ti"[^>]*style="display:none"[^>]*aria-hidden="true"/);
});
