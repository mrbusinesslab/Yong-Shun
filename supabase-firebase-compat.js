/* Temporary compatibility bridge for legacy document generators.
 * Keeps their existing db.collection('cases').doc(id).get/set API while storing in Supabase.
 */
(function () {
  const client = window.supabase.createClient('https://dephqbwfvbrawytlzuau.supabase.co', 'sb_publishable_Ko8n68XsRz8KyFnKXBP4rQ_WjByFvwv');
  const clean = value => JSON.parse(JSON.stringify(value, (_, v) => v && v.__serverTimestamp ? new Date().toISOString() : v));
  async function legacyCase(id) {
    const { data: row, error } = await client.from('cases').select('*, customers(*), documents(*)').eq('id', id).single();
    if (error && error.code !== 'PGRST116') throw error;
    if (!row) return null;
    const report = (row.documents || []).find(d => d.doc_type === 'report')?.form_data || {};
    const warranty = (row.documents || []).find(d => d.doc_type === 'warranty');
    return { ...report, caseNumber: row.case_number, clientName: row.customers?.name || '', clientContact: row.customers?.phone_alt || '', phone: row.customers?.phone || '', clientAddress: row.site_address, buildingType: row.building_type || '', inspectDate: row.inspection_date || '', warranty: warranty ? { ...(warranty.form_data?.warranty || {}), startDate: warranty.warranty_start, endDate: warranty.warranty_end } : undefined };
  }
  async function saveLegacyCase(id, raw, merge) {
    const value = clean(raw); const old = merge ? await legacyCase(id) : {}; const c = { ...old, ...value };
    const { data: userData } = await client.auth.getUser(); const uid = userData.user?.id || null;
    let caseId = id;
    const { data: found } = await client.from('cases').select('id,customer_id').eq('id', id).maybeSingle();
    if (!found) {
      const { data: customer, error: ce } = await client.from('customers').insert({name: c.clientName || '未命名客戶', phone: c.phone || null, phone_alt: c.clientContact || null, created_by: uid}).select().single(); if (ce) throw ce;
      const { error } = await client.from('cases').insert({id: caseId, case_number: c.caseNumber || `TCG-${new Date().toISOString().slice(0,7).replace('-','')}-1`, customer_id: customer.id, site_address: c.clientAddress || '未填寫地址', building_type: c.buildingType || null, inspection_date: c.inspectDate || null, created_by: uid}); if (error) throw error;
    } else {
      const { error: ce } = await client.from('customers').update({name: c.clientName || '未命名客戶', phone: c.phone || null, phone_alt: c.clientContact || null}).eq('id', found.customer_id); if (ce) throw ce;
      const { error } = await client.from('cases').update({case_number: c.caseNumber || undefined, site_address: c.clientAddress || '未填寫地址', building_type: c.buildingType || null, inspection_date: c.inspectDate || null}).eq('id', caseId); if (error) throw error;
    }
    const { data: existing } = await client.from('documents').select('id').eq('case_id', caseId).eq('doc_type', 'report').maybeSingle();
    const docPayload = {case_id: caseId, doc_type: 'report', title: '漏水檢測報告書', form_data: c, created_by: uid};
    const { error: de } = existing ? await client.from('documents').update(docPayload).eq('id', existing.id) : await client.from('documents').insert(docPayload); if (de) throw de;
    if (value.warranty?.startDate && value.warranty?.endDate) {
      const { data: warrantyDoc } = await client.from('documents').select('id').eq('case_id', caseId).eq('doc_type', 'warranty').maybeSingle();
      const warrantyPayload = { case_id: caseId, doc_type: 'warranty', title: '施工保固書', form_data: { warranty: value.warranty }, warranty_start: value.warranty.startDate.slice(0, 10), warranty_end: value.warranty.endDate.slice(0, 10), created_by: uid };
      const { error: we } = warrantyDoc ? await client.from('documents').update(warrantyPayload).eq('id', warrantyDoc.id) : await client.from('documents').insert(warrantyPayload); if (we) throw we;
    }
  }
  window.firebase = { firestore: Object.assign(() => window.db, { FieldValue: { serverTimestamp: () => ({__serverTimestamp:true}) } }), initializeApp: () => null };
  window.db = { collection: () => ({ doc: id => ({
    get: async () => { const data = await legacyCase(id); return { exists: !!data, data: () => data }; },
    set: async (data, options = {}) => saveLegacyCase(id, data, !!options.merge)
  }) }) };
  window.uploadCasePhoto = async function (caseId, photoType, file, caption) {
    if (!caseId || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(caseId)) return null;
    if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('僅支援 JPEG、PNG、WebP 照片。');
    const { data: userData } = await client.auth.getUser();
    if (!userData.user) throw new Error('請先登入 Portal 帳號。');
    const id = crypto.randomUUID(); const filename = String(file.name || 'photo').replace(/[^\w.\-()\u4e00-\u9fff]/g, '_');
    const storagePath = `${caseId}/${photoType}/${id}_${filename}`;
    const { error: uploadError } = await client.storage.from('case-photos').upload(storagePath, file, { contentType: file.type });
    if (uploadError) throw uploadError;
    const { error: rowError } = await client.from('case_photos').insert({ id, case_id: caseId, photo_type: photoType, storage_path: storagePath, original_filename: file.name, caption: caption || null, uploaded_by: userData.user.id });
    if (rowError) throw rowError;
    return storagePath;
  };
  function documentInfo() {
    const path = decodeURIComponent(location.pathname);
    if (path.includes('檢測報告書')) return { type: 'report', title: '漏水檢測報告書' };
    if (path.includes('報價單')) return { type: 'quotation', title: '工程報價單' };
    if (path.includes('保固書')) return { type: 'warranty', title: '施工保固書' };
    if (path.includes('第三方委託書')) return { type: 'commission', title: '第三方委託書' };
    if (path.includes('驗收報告')) return { type: 'acceptance', title: '施工驗收報告' };
    return null;
  }
  async function backupPdf(blob, filename) {
    const caseId = window.YSCurrentCaseId || new URLSearchParams(location.search).get('case');
    const info = documentInfo();
    if (!caseId || !info || blob.type !== 'application/pdf') return;
    const { data: userData } = await client.auth.getUser(); if (!userData.user) return;
    const { data: existing, error: findError } = await client.from('documents').select('id').eq('case_id', caseId).eq('doc_type', info.type).maybeSingle();
    if (findError) throw findError;
    const payload = { case_id: caseId, doc_type: info.type, title: info.title, status: 'issued', issued_at: new Date().toISOString(), created_by: userData.user.id };
    const { data: doc, error: docError } = existing ? await client.from('documents').update(payload).eq('id', existing.id).select().single() : await client.from('documents').insert(payload).select().single();
    if (docError) throw docError;
    const safeName = String(filename || `${info.type}.pdf`).replace(/[^\w.\-()\u4e00-\u9fff]/g, '_');
    const storagePath = `${caseId}/${info.type}/${doc.id}_${safeName}`;
    const { error: uploadError } = await client.storage.from('documents').upload(storagePath, blob, { upsert: true, contentType: 'application/pdf' });
    if (uploadError) throw uploadError;
    const { error: updateError } = await client.from('documents').update({ pdf_path: storagePath }).eq('id', doc.id);
    if (updateError) throw updateError;
    await client.from('document_audit_log').insert({ document_id: doc.id, case_id: caseId, actor_id: userData.user.id, action: 'pdf_uploaded', detail: { path: storagePath } });
  }
  // 各舊版頁面以 <a download> 輸出 PDF；在不干擾下載的前提下同步備份 Blob。
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const href = this.href, filename = this.download;
    if (filename && href && href.startsWith('blob:')) {
      fetch(href).then(r => r.blob()).then(blob => backupPdf(blob, filename)).catch(err => console.warn('PDF 備份失敗（不影響下載）：', err));
    }
    return originalAnchorClick.call(this);
  };
}());
