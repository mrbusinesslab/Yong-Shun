// ══════════════════════════════════════════════════════════════
// 詠順工程行｜共用 Supabase 案件／文件存取模組
// 由 report / quotation / warranty / acceptance-report / commission 五支
// 產生器共用，取代原本各自獨立的 Firebase Firestore 邏輯。
// ══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://dephqbwfvbrawytlzuau.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_Ko8n68XsRz8KyFnKXBP4rQ_WjByFvwv';

window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const YS_DOC_BUCKET = 'documents';

function ysSafeFileName(str) {
  return (str || '').toString().replace(/[\\/:*?"<>|]/g, '_').trim();
}

// ── 依電話比對／建立客戶，再依「客戶＋地址」比對／建立進行中案件 ──
// 回傳 { customerId, caseId, caseNumber, isNewCase }
async function ysResolveCustomerAndCase({ name, phone, phoneAlt, address }) {
  const sb = window.supabaseClient;
  name = (name || '').trim();
  phone = (phone || '').trim();
  address = (address || '').trim();

  let customerId = null;
  if (phone) {
    const { data: existing, error: findErr } = await sb.from('customers')
      .select('id').eq('phone', phone).is('deleted_at', null).maybeSingle();
    if (findErr) throw new Error('客戶查詢失敗：' + findErr.message);
    if (existing) {
      customerId = existing.id;
      const { error: updErr } = await sb.from('customers')
        .update({ name, address, phone_alt: phoneAlt || null, updated_at: new Date().toISOString() })
        .eq('id', customerId);
      if (updErr) throw new Error('客戶資料更新失敗：' + updErr.message);
    }
  }

  if (!customerId) {
    const { data: created, error: insErr } = await sb.from('customers')
      .insert({ name, phone: phone || null, phone_alt: phoneAlt || null, address })
      .select('id').single();
    if (insErr) throw new Error('客戶建立失敗：' + insErr.message);
    customerId = created.id;
  }

  let caseId = null, caseNumber = null, isNewCase = false;
  if (address) {
    const { data: existingCase, error: caseFindErr } = await sb.from('cases')
      .select('id, case_number').eq('customer_id', customerId).eq('site_address', address)
      .not('status', 'in', '(closed,cancelled)').is('deleted_at', null)
      .order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (caseFindErr) throw new Error('案件查詢失敗：' + caseFindErr.message);
    if (existingCase) { caseId = existingCase.id; caseNumber = existingCase.case_number; }
  }
  if (!caseId) isNewCase = true;

  return { customerId, caseId, caseNumber, isNewCase };
}

// ── 建立新案件，或更新既有案件的基本欄位（案號、建物類型、檢測日期等）──
async function ysUpsertCase({ caseId, customerId, caseNumber, address, buildingType, inspectionDate }) {
  const sb = window.supabaseClient;
  const payload = {
    customer_id: customerId,
    case_number: caseNumber || null,
    site_address: address || null,
    building_type: buildingType || null,
    updated_at: new Date().toISOString()
  };
  if (inspectionDate) payload.inspection_date = inspectionDate;

  if (caseId) {
    const { error } = await sb.from('cases').update(payload).eq('id', caseId);
    if (error) throw new Error('案件更新失敗：' + error.message);
    return caseId;
  } else {
    const { data, error } = await sb.from('cases').insert({ ...payload, status: 'active' }).select('id').single();
    if (error) throw new Error('案件建立失敗：' + error.message);
    return data.id;
  }
}

// ── 上傳 PDF 至 Storage，並寫入／更新 documents 表 ──
// pdfBlob 為選填：有給就上傳 PDF 並標記為「已出具」；沒給（例如自動暫存草稿）就只更新文字資料，標記為「草稿」
// doc_number 作為同一份文件的識別（同編號 = 更新，不是新建）
async function ysSaveDocument({ caseId, docType, docNumber, title, pdfBlob, formData, warrantyStart, warrantyEnd, quoteTotal, status }) {
  const sb = window.supabaseClient;
  const payload = {
    case_id: caseId,
    doc_type: docType,
    doc_number: docNumber || null,
    title: title || null,
    form_data: formData || {},
    updated_at: new Date().toISOString()
  };
  if (warrantyStart !== undefined) payload.warranty_start = warrantyStart || null;
  if (warrantyEnd !== undefined) payload.warranty_end = warrantyEnd || null;
  if (quoteTotal !== undefined && quoteTotal !== null) payload.quote_total = quoteTotal;

  if (pdfBlob) {
    const safeNo = ysSafeFileName(docNumber) || (docType + '_' + Date.now());
    const path = `${docType}/${safeNo}.pdf`;
    const { error: upErr } = await sb.storage.from(YS_DOC_BUCKET)
      .upload(path, pdfBlob, { contentType: 'application/pdf', upsert: true });
    if (upErr) throw new Error('PDF 上傳失敗：' + upErr.message);
    payload.pdf_path = path;
    payload.status = status || 'issued';
    payload.issued_at = new Date().toISOString();
  } else {
    payload.status = status || 'draft';
  }

  // 先查是否已有相同案件＋類型＋編號的文件，有就更新，沒有就新建（避免依賴資料庫 unique constraint）
  let existingDocId = null;
  if (docNumber) {
    const { data: existingDoc } = await sb.from('documents')
      .select('id').eq('case_id', caseId).eq('doc_type', docType).eq('doc_number', docNumber)
      .is('deleted_at', null).maybeSingle();
    if (existingDoc) existingDocId = existingDoc.id;
  }

  if (existingDocId) {
    const { error } = await sb.from('documents').update(payload).eq('id', existingDocId);
    if (error) throw new Error('文件資料更新失敗：' + error.message);
    return existingDocId;
  } else {
    const { data, error } = await sb.from('documents').insert(payload).select('id').single();
    if (error) throw new Error('文件資料建立失敗：' + error.message);
    return data.id;
  }
}

// ── 從 Portal 帶 ?case=xxx 進來時，載入案件＋客戶資料回填表單 ──
async function ysLoadCaseForEdit(caseId) {
  const sb = window.supabaseClient;
  const { data, error } = await sb.from('cases')
    .select('id, case_number, site_address, building_type, status, inspection_date, customers(id, name, phone, phone_alt, address)')
    .eq('id', caseId).is('deleted_at', null).maybeSingle();
  if (error || !data) return null;
  return {
    caseId: data.id,
    caseNumber: data.case_number,
    address: data.site_address,
    buildingType: data.building_type,
    inspectionDate: data.inspection_date,
    customerId: data.customers ? data.customers.id : null,
    clientName: data.customers ? data.customers.name : '',
    clientPhone: data.customers ? data.customers.phone : '',
    clientPhoneAlt: data.customers ? data.customers.phone_alt : '',
  };
}

// ── 讀取某案件已產生過的文件（讓其他產生器可以帶出檢測報告的資料，例如漏水點位）──
async function ysLoadCaseDocuments(caseId, docType) {
  const sb = window.supabaseClient;
  let q = sb.from('documents').select('id, doc_type, doc_number, form_data, warranty_start, warranty_end')
    .eq('case_id', caseId).is('deleted_at', null).order('created_at', { ascending: false });
  if (docType) q = q.eq('doc_type', docType);
  const { data, error } = await q;
  if (error) return [];
  return data || [];
}

// ── 原始照片備份上傳（report / quotation / acceptance-report 三支都會呼叫）──
// 純粹把使用者上傳的原始檔同步一份到私有 Storage 做備份，不影響頁面本身的裁切／預覽邏輯，
// 也不寫入任何資料表，上傳失敗不影響操作（呼叫端都是 try/catch 包起來）。
async function uploadCasePhoto(caseId, kind, file, label) {
  if (!caseId || !file) return;
  const sb = window.supabaseClient;
  const safeName = ysSafeFileName(file.name || 'photo');
  const path = `${caseId}/${kind}_${Date.now()}_${safeName}`;
  const { error } = await sb.storage.from('case-photos').upload(path, file, { upsert: true });
  if (error) throw new Error('照片備份上傳失敗：' + error.message);
}
