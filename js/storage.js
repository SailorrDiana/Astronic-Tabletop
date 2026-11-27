const DB_NAME = 'AstronicTabletopLocal';
const DB_VERSION = 1;
let dbPromise;

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('campaigns')) db.createObjectStore('campaigns', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assets')) {
        const store = db.createObjectStore('assets', { keyPath: 'id' });
        store.createIndex('campaignId', 'campaignId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Não foi possível abrir o armazenamento local.'));
  });
  return dbPromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Falha no armazenamento local.'));
  });
}

export async function saveCampaign(campaign) {
  const db = await openDatabase();
  const tx = db.transaction('campaigns', 'readwrite');
  tx.objectStore('campaigns').put({ ...campaign, updatedAt: Date.now() });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Salvamento cancelado.'));
  });
}

export async function getCampaign(id) {
  const db = await openDatabase();
  return requestResult(db.transaction('campaigns').objectStore('campaigns').get(id));
}

export async function getCampaigns() {
  const db = await openDatabase();
  const items = await requestResult(db.transaction('campaigns').objectStore('campaigns').getAll());
  return (items || []).sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}

export async function putAsset(campaignId, id, file, extra = {}) {
  const db = await openDatabase();
  const record = {
    id: `${campaignId}:${id}`,
    assetId: id,
    campaignId,
    name: file.name || extra.name || 'Arquivo',
    mime: file.type || extra.mime || 'application/octet-stream',
    size: file.size ?? extra.size ?? 0,
    blob: file,
    createdAt: Date.now(),
    ...extra
  };
  const tx = db.transaction('assets', 'readwrite');
  tx.objectStore('assets').put(record);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Não foi possível salvar o arquivo.'));
  });
  return record;
}

export async function getAssets(campaignId) {
  const db = await openDatabase();
  const store = db.transaction('assets').objectStore('assets');
  return requestResult(store.index('campaignId').getAll(campaignId));
}

export async function getAsset(campaignId, assetId) {
  const db = await openDatabase();
  return requestResult(db.transaction('assets').objectStore('assets').get(`${campaignId}:${assetId}`));
}

export async function deleteAsset(campaignId, assetId) {
  const db = await openDatabase();
  const tx = db.transaction('assets', 'readwrite');
  tx.objectStore('assets').delete(`${campaignId}:${assetId}`);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Não foi possível remover o arquivo.'));
  });
}

export async function deleteCampaign(id) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['campaigns', 'assets'], 'readwrite');
    tx.objectStore('campaigns').delete(id);
    const assetStore = tx.objectStore('assets');
    const keysRequest = assetStore.index('campaignId').getAllKeys(id);
    keysRequest.onsuccess = () => {
      for (const key of keysRequest.result || []) assetStore.delete(key);
    };
    keysRequest.onerror = () => {
      try { tx.abort(); } catch { /* a transação pode já estar finalizada */ }
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('Não foi possível excluir a campanha.'));
    tx.onabort = () => reject(tx.error || new Error('Não foi possível excluir a campanha.'));
  });
}

export async function replaceCampaignAndAssets(campaign, assets) {
  const db = await openDatabase();
  const tx = db.transaction(['campaigns', 'assets'], 'readwrite');
  tx.objectStore('campaigns').put(campaign);
  const store = tx.objectStore('assets');
  const request = store.index('campaignId').getAll(campaign.id);
  request.onsuccess = () => {
    request.result.forEach(item => store.delete(item.id));
    assets.forEach(asset => store.put({ ...asset, id: `${campaign.id}:${asset.assetId}`, campaignId: campaign.id }));
  };
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Falha ao restaurar o backup.'));
  });
}
