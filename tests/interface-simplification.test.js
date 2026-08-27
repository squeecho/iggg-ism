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

test('편집 화면 저장 카드는 프로젝트 정보 폭에서 진행 중 공유 현장별 exporter를 제공한다', () => {
  assert.match(html, /id="editExportCard"/);
  assert.match(html, /id="editExportSites"[^>]*aria-live="polite"/);
  assert.match(html, /function _activeSharedExportSites\(\)/);
  assert.match(html, /site\.ed&&site\.ed<td/);
  assert.match(html, /site\.confirmed===false/);
  assert.match(html, /data-kind="pdf"[^>]*exportScheduleFromEdit\(this\.dataset\.kind,this\.dataset\.pn\)/);
  assert.match(html, /data-kind="image"[^>]*exportScheduleFromEdit\(this\.dataset\.kind,this\.dataset\.pn\)/);

  const infoStart = html.indexOf('<div class="ep-info-col">');
  const infoEnd = html.indexOf('</div><!-- /ep-info-col -->', infoStart);
  const card = html.indexOf('id="editExportCard"');
  assert.ok(infoStart >= 0 && card > infoStart && card < infoEnd, '저장 카드는 프로젝트 정보와 같은 열에 있어야 한다');

  const start = html.indexOf('async function exportScheduleFromEdit(kind,pn)');
  const end = html.indexOf('async function doIMG()', start);
  assert.ok(start >= 0 && end > start);
  const wrapper = html.slice(start, end);
  assert.match(wrapper, /_activeSharedExportSites\(\)\.find/);
  assert.match(wrapper, /_cloudView=site/);
  assert.match(wrapper, /_cloudView=previousCloudView/);
  assert.match(wrapper, /await doPDF\(\)/);
  assert.match(wrapper, /await doIMG\(\)/);
  assert.doesNotMatch(wrapper, /html2canvas|new jsPDF/);
});

test('차트 협력업체 버튼과 통합 탭은 화면에서 숨긴다', () => {
  assert.match(html, /id="btnCtorCheck"[^>]*style="display:none"[^>]*aria-hidden="true"/);
  assert.match(html, /id="ti"[^>]*style="display:none"[^>]*aria-hidden="true"/);
});

test('차트 도구모음은 편집 기능을 주 기능으로, 출력·자동배치를 무채색 보조 기능으로 구분한다', () => {
  const toolbarStart = html.indexOf('<div class="ca" id="ca">');
  const toolbarEnd = html.indexOf('<div id="pa">', toolbarStart);
  assert.ok(toolbarStart >= 0 && toolbarEnd > toolbarStart);
  const toolbar = html.slice(toolbarStart, toolbarEnd);

  const primaryStart = toolbar.indexOf('ca-primary-row');
  const utilityStart = toolbar.indexOf('ca-utility-row');
  assert.ok(primaryStart >= 0 && utilityStart > primaryStart);
  for (const id of ['btnUndo', 'btnRedo', 'chartBarEditToggle', 'chartAddTask']) {
    const position = toolbar.indexOf(`id="${id}"`);
    assert.ok(position > primaryStart && position < utilityStart, `${id}는 주 기능군에 있어야 한다`);
  }
  for (const id of ['chartPdfBtn', 'chartImageBtn', 'btnAutoSched']) {
    const position = toolbar.indexOf(`id="${id}"`);
    assert.ok(position > utilityStart, `${id}는 보조 기능군에 있어야 한다`);
    assert.match(toolbar, new RegExp(`class="[^"]*chart-toolbar-btn[^"]*ca-utility-btn[^"]*" id="${id}"`));
  }
  assert.match(html, /\.ca \.chart-toolbar-btn\{height:34px;min-height:34px;/);
  assert.match(html, /\.ca-utility-btn\{background:transparent;/);
});
