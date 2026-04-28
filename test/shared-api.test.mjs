// Unit tests for src/shared/api.ts.
//
// The shared module is pure / Electron-free, so Node's test runner can
// load it directly from the tsc output. Tests cover:
//
//   - escapeHtml / textToHtml             (security-relevant: prose → HTML)
//   - perspectiveConfigFor                (modality → label/suggestions)
//   - defaultModalityForSeries            (DICOM tag → UI modality)
//   - deriveDefaultCase                   (anonymise summary → Case form)
//   - buildCaseCreatePayload              (Case → POST /api/v1/cases body)
//   - buildStudyCreatePayload             (Study → POST .../studies body)
//
// Run via: npm test (after npm run build:frontend).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const api = await import('../dist/shared/api.js');

// --- escapeHtml ---

test('escapeHtml: replaces & < > and leaves other characters alone', () => {
  assert.equal(api.escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  assert.equal(api.escapeHtml('plain text'), 'plain text');
  assert.equal(api.escapeHtml(''), '');
});

test('escapeHtml: ampersand is escaped first so & → &amp; not &amp;amp;', () => {
  // Doing & last would double-escape: < → &lt;, then & in &lt; → &amp;lt;.
  // The single-pass replace([&<>]) implementation guarantees correct order.
  assert.equal(api.escapeHtml('<&>'), '&lt;&amp;&gt;');
});

test("escapeHtml: does NOT escape quotes (we don't emit attribute values)", () => {
  // textToHtml only puts content inside <p>...</p>, never inside an
  // attribute. Escaping " or ' would just clutter the output.
  assert.equal(api.escapeHtml(`he said "ok" and 'fine'`), `he said "ok" and 'fine'`);
});

// --- textToHtml ---

test('textToHtml: empty / whitespace-only input returns empty string', () => {
  assert.equal(api.textToHtml(''), '');
  assert.equal(api.textToHtml('   \n\n  \n'), '');
  assert.equal(api.textToHtml(null), '');
  assert.equal(api.textToHtml(undefined), '');
});

test('textToHtml: single paragraph wraps in <p>', () => {
  assert.equal(api.textToHtml('hello world'), '<p>hello world</p>');
});

test('textToHtml: blank-line separated paragraphs each get their own <p>', () => {
  assert.equal(
    api.textToHtml('first\n\nsecond\n\nthird'),
    '<p>first</p><p>second</p><p>third</p>',
  );
});

test('textToHtml: single newlines inside a paragraph become <br />', () => {
  assert.equal(
    api.textToHtml('line one\nline two'),
    '<p>line one<br />line two</p>',
  );
});

test('textToHtml: HTML metacharacters in content are escaped', () => {
  // Critical: this is the only path Radiopaedia receives user prose
  // through, so leaking unescaped < or & would persist as broken HTML
  // (or worse, allow markup injection) on the published case.
  assert.equal(
    api.textToHtml('a < b & c > d'),
    '<p>a &lt; b &amp; c &gt; d</p>',
  );
});

test('textToHtml: tag-shaped input is escaped, not interpreted', () => {
  assert.equal(
    api.textToHtml('<script>alert(1)</script>'),
    '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
  );
});

test('textToHtml: collapses multiple blank lines and ignores empty paragraphs', () => {
  // \n\n\n\n splits to ['x', '', 'y'] which after filter becomes ['x','y'].
  assert.equal(api.textToHtml('x\n\n\n\ny'), '<p>x</p><p>y</p>');
});

// --- perspectiveConfigFor ---

test('perspectiveConfigFor: returns the default config for empty modality', () => {
  const cfg = api.perspectiveConfigFor('');
  assert.equal(cfg, api.PERSPECTIVE_MODALITY_DEFAULT);
});

test('perspectiveConfigFor: returns the modality-specific config', () => {
  const ct = api.perspectiveConfigFor('CT');
  assert.equal(ct.specifics_label, 'Contrast / window');
  assert.ok(ct.perspectives.includes('Axial'));
  assert.ok(ct.specifics.includes('non-contrast'));
});

test('perspectiveConfigFor: every modality in the table has consistent shape', () => {
  // Ensures a refactor that adds a modality but forgets a field surfaces
  // here rather than silently rendering a blank typeahead.
  for (const opt of api.MODALITY_OPTIONS) {
    const cfg = api.perspectiveConfigFor(opt.name);
    assert.equal(typeof cfg.perspective_label, 'string', `${opt.name} perspective_label`);
    assert.ok(Array.isArray(cfg.perspectives), `${opt.name} perspectives`);
    assert.equal(typeof cfg.specifics_label, 'string', `${opt.name} specifics_label`);
    assert.ok(Array.isArray(cfg.specifics), `${opt.name} specifics`);
  }
});

// --- defaultModalityForSeries ---

test('defaultModalityForSeries: maps common DICOM modalities', () => {
  assert.equal(api.defaultModalityForSeries('CT'), 'CT');
  assert.equal(api.defaultModalityForSeries('MR'), 'MRI');
  assert.equal(api.defaultModalityForSeries('US'), 'Ultrasound');
  assert.equal(api.defaultModalityForSeries('MG'), 'Mammography');
  assert.equal(api.defaultModalityForSeries('XA'), 'DSA (angiography)');
  assert.equal(api.defaultModalityForSeries('RF'), 'Fluoroscopy');
});

test('defaultModalityForSeries: x-ray family all collapses to X-ray', () => {
  for (const code of ['CR', 'DX', 'RG', 'XR', 'X-RAY', 'XA-PLAIN']) {
    assert.equal(api.defaultModalityForSeries(code), 'X-ray', `code=${code}`);
  }
});

test('defaultModalityForSeries: nuclear-medicine family collapses to Nuclear medicine', () => {
  for (const code of ['NM', 'PT', 'PET']) {
    assert.equal(api.defaultModalityForSeries(code), 'Nuclear medicine', `code=${code}`);
  }
});

test('defaultModalityForSeries: case- and whitespace-insensitive', () => {
  assert.equal(api.defaultModalityForSeries(' ct '), 'CT');
  assert.equal(api.defaultModalityForSeries('mr'), 'MRI');
});

test('defaultModalityForSeries: unknown / null / empty → null', () => {
  assert.equal(api.defaultModalityForSeries(null), null);
  assert.equal(api.defaultModalityForSeries(undefined), null);
  assert.equal(api.defaultModalityForSeries(''), null);
  assert.equal(api.defaultModalityForSeries('PR'), null);
  assert.equal(api.defaultModalityForSeries('🤷'), null);
});

// --- deriveDefaultCase ---

test('deriveDefaultCase: seeds title from the first study description', () => {
  const summary = {
    studies: [
      { description: 'CT chest with contrast', series: [] },
      { description: 'should not be used', series: [] },
    ],
  };
  const c = api.deriveDefaultCase(summary, '/tmp/output');
  assert.equal(c.title, 'CT chest with contrast');
  assert.equal(c.output_root, '/tmp/output');
  assert.equal(c.source_summary, summary);
});

test('deriveDefaultCase: clamps title to CASE_TITLE_MAX', () => {
  const long = 'x'.repeat(api.CASE_TITLE_MAX + 50);
  const c = api.deriveDefaultCase({ studies: [{ description: long, series: [] }] }, '/o');
  assert.equal(c.title.length, api.CASE_TITLE_MAX);
  assert.ok(c.title.startsWith('xxx'));
});

test('deriveDefaultCase: missing description leaves title undefined', () => {
  const c = api.deriveDefaultCase({ studies: [{ description: '', series: [] }] }, '/o');
  assert.equal(c.title, undefined);
});

test('deriveDefaultCase: empty studies array leaves title undefined', () => {
  const c = api.deriveDefaultCase({ studies: [] }, '/o');
  assert.equal(c.title, undefined);
  // source_summary + output_root still populated.
  assert.deepEqual(c.source_summary, { studies: [] });
  assert.equal(c.output_root, '/o');
});

// --- buildCaseCreatePayload ---

function fullCase(overrides = {}) {
  // Minimum populated Case the UI could submit. Adjust per test.
  return {
    title: 'Pneumothorax',
    system_id: 4,
    age: '34 years',
    patient_sex: 'M',
    diagnostic_certainty_id: 2,
    suitable_for_quiz: true,
    clinical_history: 'sudden chest pain',
    case_discussion: 'first paragraph\n\nsecond paragraph',
    source_summary: { studies: [] },
    output_root: '/tmp/out',
    ...overrides,
  };
}

test('buildCaseCreatePayload: includes all populated fields, HTML-wraps prose', () => {
  const out = api.buildCaseCreatePayload(fullCase());
  assert.equal(out.title, 'Pneumothorax');
  assert.equal(out.system_id, 4);
  assert.equal(out.age, '34 years');
  assert.equal(out.gender, 'Male');
  assert.equal(out.presentation, 'sudden chest pain');
  assert.equal(out.body, '<p>first paragraph</p><p>second paragraph</p>');
  assert.equal(out.diagnostic_certainty_id, 2);
  assert.equal(out.suitable_for_quiz, true);
});

test('buildCaseCreatePayload: trims title and presentation', () => {
  const out = api.buildCaseCreatePayload(fullCase({
    title: '  Pneumothorax  ',
    clinical_history: '  sudden chest pain  ',
  }));
  assert.equal(out.title, 'Pneumothorax');
  assert.equal(out.presentation, 'sudden chest pain');
});

test('buildCaseCreatePayload: maps F → Female, omits gender for O / null', () => {
  assert.equal(api.buildCaseCreatePayload(fullCase({ patient_sex: 'F' })).gender, 'Female');
  assert.equal('gender' in api.buildCaseCreatePayload(fullCase({ patient_sex: 'O' })), false);
  assert.equal('gender' in api.buildCaseCreatePayload(fullCase({ patient_sex: null })), false);
});

test('buildCaseCreatePayload: omits empty / null / undefined fields entirely', () => {
  // The API is happier with omitted keys than with empty strings or
  // explicit nulls — the setIf helper enforces that.
  const out = api.buildCaseCreatePayload(fullCase({
    age: '',
    clinical_history: '',
    case_discussion: '',
    diagnostic_certainty_id: undefined,
  }));
  assert.equal('age' in out, false);
  assert.equal('presentation' in out, false);
  assert.equal('body' in out, false);
  assert.equal('diagnostic_certainty_id' in out, false);
});

test('buildCaseCreatePayload: suitable_for_quiz is preserved when explicitly false', () => {
  // Users may opt out of quiz inclusion — false must be sent, not omitted.
  const out = api.buildCaseCreatePayload(fullCase({ suitable_for_quiz: false }));
  assert.equal(out.suitable_for_quiz, false);
});

test('buildCaseCreatePayload: suitable_for_quiz is omitted when undefined', () => {
  const out = api.buildCaseCreatePayload(fullCase({ suitable_for_quiz: undefined }));
  assert.equal('suitable_for_quiz' in out, false);
});

test('buildCaseCreatePayload: case_discussion HTML-escapes user content', () => {
  // Regression guard: a user typing < or & in the discussion box must
  // not produce broken HTML on the published case.
  const out = api.buildCaseCreatePayload(fullCase({
    case_discussion: 'a < b & c > d',
  }));
  assert.equal(out.body, '<p>a &lt; b &amp; c &gt; d</p>');
});

// --- buildStudyCreatePayload ---

test('buildStudyCreatePayload: includes modality + position always', () => {
  const out = api.buildStudyCreatePayload({ modality: 'CT' }, 2);
  assert.equal(out.modality, 'CT');
  assert.equal(out.position, 2);
});

test('buildStudyCreatePayload: HTML-wraps findings, trims caption, omits empty', () => {
  const out = api.buildStudyCreatePayload({
    modality: 'CT',
    findings: 'small left apical pneumothorax',
    caption: '  baseline  ',
  }, 3);
  assert.equal(out.findings, '<p>small left apical pneumothorax</p>');
  assert.equal(out.caption, 'baseline');
  assert.equal(out.position, 3);
});

test('buildStudyCreatePayload: omits findings + caption when empty / unset', () => {
  const out = api.buildStudyCreatePayload({ modality: 'X-ray' }, 2);
  assert.equal('findings' in out, false);
  assert.equal('caption' in out, false);
});

test('buildStudyCreatePayload: does NOT include plane / perspective', () => {
  // The studies-create permit list is modality / findings / position /
  // caption only. Plane is sent later via image_preparation. Including
  // it here would be silently dropped at best, 400 at worst.
  const out = api.buildStudyCreatePayload({ modality: 'CT', plane: 'Axial' }, 2);
  assert.equal('plane' in out, false);
  assert.equal('perspective' in out, false);
});
