// フォーム入力のテスト用PDF（form.pdf）を作る：node tests/fixtures/make-form-pdf.js
// 1ページ目：名前（文字）・同意する（チェック）・連絡方法（ラジオ）・都道府県（選択）、2ページ目：備考（複数行の文字）
import { writeFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFString, StandardFonts } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const form = pdf.getForm();
const p1 = pdf.addPage([595, 842]);
const p2 = pdf.addPage([595, 842]);
const label = (page, text, y) => page.drawText(text, { x: 50, y, size: 12, font });

label(p1, 'Name', 745);
const name = form.createTextField('name');
name.addToPage(p1, { x: 160, y: 738, width: 300, height: 24 });
name.acroField.dict.set(PDFName.of('TU'), PDFString.of('Your name'));

label(p1, 'Agree', 705);
form.createCheckBox('agree').addToPage(p1, { x: 160, y: 700, width: 18, height: 18 });

label(p1, 'Contact', 665);
const contact = form.createRadioGroup('contact');
contact.addOptionToPage('mail', p1, { x: 160, y: 660, width: 16, height: 16 });
contact.addOptionToPage('phone', p1, { x: 240, y: 660, width: 16, height: 16 });

label(p1, 'Prefecture', 625);
const pref = form.createDropdown('pref');
pref.addOptions(['Tokyo', 'Osaka', 'Hokkaido']);
pref.addToPage(p1, { x: 160, y: 618, width: 200, height: 24 });

label(p2, 'Note', 745);
const note = form.createTextField('note');
note.enableMultiline();
note.addToPage(p2, { x: 160, y: 640, width: 360, height: 120 });

await writeFile(new URL('form.pdf', import.meta.url), await pdf.save());
console.log('form.pdf を作成しました');
