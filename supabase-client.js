/* 詠順工程行共用 Supabase Client
 * 先在頁面載入：<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 * 再載入本檔：<script src="./supabase-client.js"></script>
 */
(function () {
  'use strict';

  const PROJECT_URL = 'https://dephqbwfvbrawytlzuau.supabase.co';
  const PUBLISHABLE_KEY = 'sb_publishable_Ko8n68XsRz8KyFnKXBP4rQ_WjByFvwv';
  const client = window.supabase.createClient(PROJECT_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  function required(value, label) {
    if (!value) throw new Error(`缺少必要欄位：${label}`);
    return value;
  }
  function safeName(filename) {
    return String(filename || 'file').replace(/[^\w.\-()\u4e00-\u9fff]/g, '_');
  }
  async function currentUser() {
    const { data, error } = await client.auth.getUser();
    if (error) throw error;
    return data.user;
  }
  async function createCase({ customer, siteAddress, caseNumber, buildingType, inspectionDate, notes }) {
    const user = await currentUser();
    const { data: customerRow, error: customerError } = await client
      .from('customers').insert({ ...customer, created_by: user.id }).select().single();
    if (customerError) throw customerError;
    const { data, error } = await client.from('cases').insert({
      case_number: required(caseNumber, '案號'), customer_id: customerRow.id,
      site_address: required(siteAddress, '案場地址'), building_type: buildingType || null,
      inspection_date: inspectionDate || null, notes: notes || null, created_by: user.id
    }).select().single();
    if (error) throw error;
    return data;
  }
  async function saveDocument({ id, caseId, docType, docNumber, title, formData, warrantyStart, warrantyEnd, quoteTotal, status = 'draft' }) {
    const user = await currentUser();
    const payload = {
      case_id: required(caseId, '案件 ID'), doc_type: required(docType, '文件類型'),
      doc_number: docNumber || null, title: required(title, '文件標題'), form_data: formData || {},
      warranty_start: warrantyStart || null, warranty_end: warrantyEnd || null,
      quote_total: quoteTotal ?? null, status, created_by: user.id
    };
    const query = id ? client.from('documents').update(payload).eq('id', id) : client.from('documents').insert(payload);
    const { data, error } = await query.select().single();
    if (error) throw error;
    await client.from('document_audit_log').insert({ document_id: data.id, case_id: caseId, actor_id: user.id, action: id ? 'updated' : 'created' });
    return data;
  }
  async function uploadDocumentPdf({ documentId, caseId, docType, file, stamped = false }) {
    required(file, 'PDF 檔案'); required(documentId, '文件 ID'); required(caseId, '案件 ID');
    if (file.type && file.type !== 'application/pdf') throw new Error('只能上傳 PDF 檔案。');
    const path = `${caseId}/${docType}/${documentId}${stamped ? '_stamped' : ''}_${safeName(file.name || 'document.pdf')}`;
    const { error: uploadError } = await client.storage.from('documents').upload(path, file, { upsert: true, contentType: 'application/pdf' });
    if (uploadError) throw uploadError;
    const field = stamped ? 'pdf_stamped_path' : 'pdf_path';
    const { error } = await client.from('documents').update({ [field]: path, status: 'issued', issued_at: new Date().toISOString() }).eq('id', documentId);
    if (error) throw error;
    const user = await currentUser();
    await client.from('document_audit_log').insert({ document_id: documentId, case_id: caseId, actor_id: user.id, action: 'pdf_uploaded', detail: { path, stamped } });
    return path;
  }
  async function uploadCasePhoto({ caseId, photoType, file, caption, sortOrder = 0, takenAt }) {
    required(caseId, '案件 ID'); required(file, '照片檔案');
    if (file.type && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('只接受 JPEG、PNG 或 WebP 照片。');
    const photoId = crypto.randomUUID();
    const path = `${caseId}/${photoType}/${photoId}_${safeName(file.name)}`;
    const { error: uploadError } = await client.storage.from('case-photos').upload(path, file, { contentType: file.type });
    if (uploadError) throw uploadError;
    const user = await currentUser();
    const { data, error } = await client.from('case_photos').insert({
      id: photoId, case_id: caseId, photo_type: photoType, storage_path: path,
      original_filename: file.name, caption: caption || null, sort_order: sortOrder,
      taken_at: takenAt || null, uploaded_by: user.id
    }).select().single();
    if (error) throw error;
    return data;
  }
  async function signedUrl(bucket, path, expiresIn = 900) {
    const { data, error } = await client.storage.from(bucket).createSignedUrl(path, expiresIn);
    if (error) throw error;
    return data.signedUrl;
  }

  window.YongShunSupabase = Object.freeze({ client, currentUser, createCase, saveDocument, uploadDocumentPdf, uploadCasePhoto, signedUrl });
}());
