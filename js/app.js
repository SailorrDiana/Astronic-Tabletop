import { saveCampaign, getCampaign, getCampaigns, putAsset, getAssets, deleteAsset, deleteCampaign, replaceCampaignAndAssets } from './storage.js';
import {
  auth, registerFirebaseAccount, loginFirebaseAccount, getFirebaseProfile, isAuthorizedMaster,
  logoutFirebaseAccount, waitForAuthUser, createFirebaseSession, getMasterActiveSession,
  getMasterSessionHistory, endFirebaseSession, joinFirebaseSessionByCode, leaveFirebaseSession,
  watchFirebaseParticipants, watchFirebaseSessionInfo, watchFirebasePublishedState,
  publishFirebaseState, watchFirebaseRtcOffers, writeFirebaseRtcOffer, watchFirebaseRtcAnswer,
  writeFirebaseRtcAnswer, addFirebaseRtcCandidate, watchFirebaseRtcCandidates, removeFirebaseRtcPlayerSignals
} from './firebase.js';

const $ = (id) => document.getElementById(id);
const state = {
  campaign: null, assets: [], activeView: 'map', libraryFilter: 'all', markerMode: false,
  objectUrls: new Map(), selectedAudioId: null, audioFilter: { type: 'all', id: null },
  pendingNpcId: null, monitorExpanded: false, user: null, role: null, currentSession: null,
  sessionParticipantsUnsubscribe: null, playerSessionInfoUnsubscribe: null, playerPublishedStateUnsubscribe: null, playerRtcOffersUnsubscribe: null,
  sessionListenerId: null, sessionRenderToken: 0, remoteSessionEnded: false,
  masterPeerConnections: new Map(), playerPeerConnections: new Map(), remotePublishedState: null, remoteAssets: new Map(), remoteIncomingTransfers: new Map(), remoteConnectionError: false,
  remoteAssetUrls: new Map(), playerRtcOfferIds: new Set(), lastPublishedMapState: null,
  remoteOpenHandoutId: null, monitorOpenHandoutId: null, remoteAudioElement: null, remoteAudioAssetId: null, remoteAudioActivated: false,
  remoteRequestedAssetRevisions: new Set(), pendingPlayerMapActions: [],
  remoteDismissedNpcId: null, remoteDismissedNpcPublishedAt: null
};
const views = { map: 'Mapa', npcs: 'NPCs', library: 'Biblioteca', audio: 'Áudio', handouts: 'Handouts' };

function uid(prefix = 'id') { return `${prefix}_${Date.now().toString(36)}_${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`; }
function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch])); }
function formatBytes(bytes = 0) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`; return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
function formatTime(seconds = 0) { if (!Number.isFinite(seconds)) return '00:00'; return `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(Math.floor(seconds % 60)).padStart(2,'0')}`; }
function inferKind(file) { if (file.type.startsWith('audio/')) return 'audio'; if (file.type.startsWith('image/') || file.name.toLowerCase().endsWith('.gif')) return 'image'; return 'document'; }
function getAssetUrl(asset) { if (!asset?.blob) return ''; if (!state.objectUrls.has(asset.assetId)) state.objectUrls.set(asset.assetId, URL.createObjectURL(asset.blob)); return state.objectUrls.get(asset.assetId); }
function npcPortraitAssetId(npc) { return npc?.portraitCropAssetId || npc?.portraitAssetId || null; }
function clampPercent(value) { return Math.max(0, Math.min(100, Number(value) || 0)); }
function getPortraitCropRect(imageWidth, imageHeight, x = 50, y = 50, zoom = 1) {
  const ratio = 4 / 5;
  const baseWidth = Math.min(imageWidth, imageHeight * ratio);
  const baseHeight = Math.min(imageHeight, imageWidth / ratio);
  const scale = Math.max(1, Number(zoom) || 1);
  const width = baseWidth / scale, height = baseHeight / scale;
  const maxLeft = Math.max(0, imageWidth - width), maxTop = Math.max(0, imageHeight - height);
  return { sx: maxLeft * clampPercent(x) / 100, sy: maxTop * clampPercent(y) / 100, sw: width, sh: height, maxLeft, maxTop };
}
function drawPortraitCrop(canvas, image, x = 50, y = 50, zoom = 1) {
  const rect = getPortraitCropRect(image.width || image.naturalWidth, image.height || image.naturalHeight, x, y, zoom);
  canvas.width = 800; canvas.height = 1000;
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, canvas.width, canvas.height);
  return rect;
}
async function decodeAssetImage(asset) {
  if (!asset?.blob) throw new Error('O arquivo do retrato não está disponível.');
  if (typeof createImageBitmap === 'function') return createImageBitmap(asset.blob);
  const url = URL.createObjectURL(asset.blob);
  try { const image = new Image(); image.src = url; if (image.decode) await image.decode(); else await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; }); return image; }
  finally { URL.revokeObjectURL(url); }
}
async function createPortraitCropBlob(asset, x, y, zoom) {
  const image = await decodeAssetImage(asset), canvas = document.createElement('canvas');
  drawPortraitCrop(canvas, image, x, y, zoom);
  if (typeof image.close === 'function') image.close();
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Não foi possível gerar o retrato recortado.')), 'image/png'));
}
async function saveNpcPortraitCrop(npc, sourceAsset, x, y, zoom) {
  if (!sourceAsset) return null;
  const blob = await createPortraitCropBlob(sourceAsset, x, y, zoom), cropId = `npc_crop_${npc.id}`;
  const saved = await putAsset(state.campaign.id, cropId, blob, { kind: 'npcPortraitCrop', name: `${npc.name || 'NPC'} - retrato recortado.png`, mime: 'image/png', size: blob.size });
  state.assets = state.assets.filter(asset => asset.assetId !== cropId); state.assets.push({ ...saved, assetId: cropId });
  const oldUrl = state.objectUrls.get(cropId); if (oldUrl) URL.revokeObjectURL(oldUrl); state.objectUrls.delete(cropId);
  return cropId;
}
async function ensureNpcPortraitCrops() {
  for (const npc of state.campaign.npcs) {
    npc.portraitZoom ??= 1; npc.portraitX ??= 50; npc.portraitY ??= 50; npc.portraitCropAssetId ??= null;
    if (!npc.portraitAssetId) { npc.portraitCropAssetId = null; continue; }
    const hasCrop = npc.portraitCropAssetId && state.assets.some(asset => asset.assetId === npc.portraitCropAssetId);
    if (!hasCrop) {
      const source = state.assets.find(asset => asset.assetId === npc.portraitAssetId);
      if (source) npc.portraitCropAssetId = await saveNpcPortraitCrop(npc, source, npc.portraitX, npc.portraitY, npc.portraitZoom);
    }
  }
  state.campaign.markers.forEach(marker => { if (marker.type === 'npc' && marker.visibleToPlayers) marker.publishedSnapshot = makeMarkerSnapshot(marker); });
  const npcId = state.campaign.shared.npcPresentation?.npcId;
  if (npcId) { const npc = state.campaign.npcs.find(item => item.id === npcId); if (npc) state.campaign.shared.npcPresentation = makeNpcPresentationSnapshot(npc); }
}
function revokeObjectUrls() { state.objectUrls.forEach(url => URL.revokeObjectURL(url)); state.objectUrls.clear(); }
function toast(message) { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2800); }
function emptyState(icon, title, description) { return `<div class="empty-state"><span>${icon}</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p></div>`; }
function blankCampaign(name) {
  return {
    id: uid('campaign'), name: name.trim(), createdAt: Date.now(), updatedAt: Date.now(),
    maps: [], editorMapId: null, editorMapStack: [], markers: [], npcs: [], handouts: [],
    audioAlbums: [{ id: 'album_soundtrack', name: 'Trilha sonora', trackIds: [] }, { id: 'album_ambience', name: 'Ambientes', trackIds: [] }],
    shared: { mapId: null, mapStack: [], presentation: null, audioTrackId: null, focusedNpcId: null }
  };
}
function normalizeCampaign(campaign) {
  campaign.maps ||= [];
  campaign.markers ||= [];
  campaign.npcs ||= [];
  campaign.handouts ||= [];
  campaign.audioAlbums ||= [];
  campaign.audioAlbums.forEach(album => { album.trackIds ||= []; });
  // Migra as antigas pastas para álbuns, preservando nomes e identificadores.
  (campaign.audioFolders || []).forEach(folder => {
    if (!campaign.audioAlbums.some(album => album.id === folder.id)) campaign.audioAlbums.push({ id: folder.id, name: folder.name, trackIds: [] });
  });
  delete campaign.audioFolders;
  campaign.editorMapStack ||= [];
  if (!campaign.maps.length && campaign.mapAssetId) {
    campaign.maps.push({ id: 'map_main', assetId: campaign.mapAssetId, name: campaign.mapName || 'Mapa principal' });
  }
  campaign.editorMapId ||= campaign.maps[0]?.id || null;
  campaign.markers.forEach(marker => {
    if (!marker.mapId) marker.mapId = campaign.maps.find(map => map.assetId === marker.mapAssetId)?.id || campaign.maps[0]?.id || null;
    if (!marker.childMapId && marker.childMapAssetId) marker.childMapId = campaign.maps.find(map => map.assetId === marker.childMapAssetId)?.id || null;
    marker.visibleToPlayers ??= false;
    marker.playerClickable ??= false;
    marker.iconMode ||= marker.type === 'npc' ? 'portrait' : 'pin';
  });
  campaign.npcs.forEach(npc => { npc.portraitZoom ??= 1; npc.portraitX ??= 50; npc.portraitY ??= 50; npc.portraitCropAssetId ??= null; });
  campaign.shared ||= { mapId: null, mapStack: [], presentation: null, audioTrackId: null, focusedNpcId: null };
  campaign.shared.mapStack ||= [];
  campaign.shared.presentation ??= null;
  campaign.shared.audioTrackId ??= null;
  campaign.shared.focusedNpcId ??= null;
  campaign.shared.mapSnapshot ??= null;
  if (!campaign.shared.mapSnapshot && campaign.shared.mapId) { const legacyMap = campaign.maps.find(map => map.id === campaign.shared.mapId); if (legacyMap) campaign.shared.mapSnapshot = { id: legacyMap.id, assetId: legacyMap.assetId, name: legacyMap.name }; }
  campaign.shared.npcPresentation ??= null;
  campaign.shared.focusedMarkerId ??= null;
  campaign.shared.audioPlayback ||= { playing: false, volume: 0.7, currentTime: 0 };
  return campaign;
}
function modal(title, body, eyebrow = 'ASTRONIC TABLETOP') {
  $('modalEyebrow').textContent = eyebrow; $('modalTitle').textContent = title; $('modalBody').innerHTML = body;
  $('modalBody').querySelectorAll('[data-modal-cancel]').forEach(button => button.addEventListener('click', closeModal));
  $('modalBackdrop').classList.remove('hidden'); $('modalCloseButton').focus();
}
function closeModal() { $('modalBackdrop').classList.add('hidden'); $('modalBody').innerHTML = ''; }
$('modalCloseButton').addEventListener('click', closeModal);
$('modalBackdrop').addEventListener('click', event => { if (event.target === $('modalBackdrop')) closeModal(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeModal(); if (!$('playerViewScreen').classList.contains('hidden')) closePlayerView(); } });

async function persist() {
  if (!state.campaign) return;
  state.campaign.updatedAt = Date.now();
  await saveCampaign(state.campaign);
  $('sidebarCampaignName').textContent = state.campaign.name;
  $('topbarCampaignName').textContent = state.campaign.name;
  renderPlayerMonitor();
}
async function loadCampaign(rawCampaign) {
  $('audioElement').pause(); $('audioElement').removeAttribute('src'); $('audioElement').load(); state.selectedAudioId = null;
  revokeObjectUrls();
  state.campaign = normalizeCampaign(rawCampaign);
  state.monitorOpenHandoutId = null;
  state.audioFilter = { type: 'all', id: null };
  state.assets = (await getAssets(state.campaign.id)).map(asset => ({ ...asset, assetId: asset.assetId || asset.id?.split(':').at(-1) }));
  // Faixas que pertenciam a pastas antigas passam a integrar o álbum equivalente.
  for (const track of state.assets.filter(asset => asset.kind === 'audio' && asset.folderId)) {
    const album = state.campaign.audioAlbums.find(item => item.id === track.folderId);
    if (album && !album.trackIds.includes(track.assetId)) album.trackIds.push(track.assetId);
    delete track.folderId;
    await putAsset(state.campaign.id, track.assetId, track.blob, { kind: 'audio', name: track.name, mime: track.mime, size: track.size });
  }
  // Retratos antigos usados por NPCs passam para a biblioteca exclusiva de personagens.
  for (const npc of state.campaign.npcs) {
    const portrait = state.assets.find(asset => asset.assetId === npc.portraitAssetId);
    if (portrait && portrait.kind === 'image') {
      portrait.kind = 'npcPortrait';
      await putAsset(state.campaign.id, portrait.assetId, portrait.blob, { kind: 'npcPortrait', name: portrait.name, mime: portrait.mime, size: portrait.size });
    }
  }
  await ensureNpcPortraitCrops();
  state.activeView = 'map'; state.markerMode = false; state.pendingNpcId = null;
  if (state.campaign.shared.audioTrackId && state.assets.some(asset => asset.assetId === state.campaign.shared.audioTrackId)) { state.selectedAudioId = state.campaign.shared.audioTrackId; const sharedTrack = state.assets.find(asset => asset.assetId === state.selectedAudioId); $('audioElement').src = getAssetUrl(sharedTrack); $('audioElement').volume = state.campaign.shared.audioPlayback?.volume ?? 0.7; $('audioVolume').value = $('audioElement').volume; $('audioVolumeValue').textContent = `${Math.round($('audioElement').volume * 100)}%`; $('audioElement').load(); }
  $('welcomeScreen').classList.add('hidden'); $('appShell').classList.remove('hidden');
  await persist(); renderAll(); renderAudioDock();
}
async function createCampaign(name) {
  if (!name.trim()) return;
  const campaign = blankCampaign(name); await saveCampaign(campaign); await loadCampaign(campaign);
  toast('Campanha criada. Vamos preparar seus mapas e personagens.');
}
function showCreateCampaignModal() {
  modal('Criar campanha', `<form id="createCampaignForm"><div class="form-field"><label for="campaignNameInput">Nome da campanha</label><input id="campaignNameInput" name="name" maxlength="80" required placeholder="Ex.: Astrae — Takayama"></div><div class="settings-note">A campanha e os arquivos serão salvos localmente neste dispositivo. Você poderá exportar um backup completo a qualquer momento.</div><div class="modal-actions"><button type="button" class="button button-secondary" data-modal-cancel>Cancelar</button><button class="button button-primary" type="submit">Criar campanha</button></div></form>`);
  $('createCampaignForm').addEventListener('submit', async event => { event.preventDefault(); const name = new FormData(event.currentTarget).get('name'); closeModal(); await createCampaign(name); });
}
async function showCampaignList() {
  const campaigns = await getCampaigns();
  const content = campaigns.length ? campaigns.map(item => `<div class="campaign-row"><div><strong>${escapeHtml(item.name)}</strong><small>Atualizada em ${new Date(item.updatedAt || item.createdAt).toLocaleDateString('pt-BR')}${state.campaign?.id === item.id ? ' · Campanha aberta' : ''}</small></div><div class="campaign-row-actions"><button class="button button-secondary button-small" data-open-campaign="${escapeHtml(item.id)}">Abrir</button><button class="button button-delete button-small" data-delete-campaign="${escapeHtml(item.id)}">Excluir</button></div></div>`).join('') : emptyState('✦','Nenhuma campanha salva','Crie sua primeira campanha para começar.');
  modal('Suas campanhas', `<div class="campaign-list">${content}</div><div class="modal-actions"><button class="button button-secondary" data-modal-cancel>Fechar</button><button class="button button-primary" id="newCampaignFromList">＋ Nova campanha</button></div>`);
  $('modalBody').querySelectorAll('[data-open-campaign]').forEach(button => button.addEventListener('click', async () => { const item = await getCampaign(button.dataset.openCampaign); closeModal(); if (item) await loadCampaign(item); }));
  $('modalBody').querySelectorAll('[data-delete-campaign]').forEach(button => button.addEventListener('click', () => showDeleteCampaignConfirmation(button.dataset.deleteCampaign)));
  $('newCampaignFromList').addEventListener('click', showCreateCampaignModal);
}

async function showDeleteCampaignConfirmation(campaignId) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) { toast('Essa campanha não foi encontrada.'); await showCampaignList(); return; }
  const assets = await getAssets(campaignId);
  const isActiveCampaign = state.campaign?.id === campaignId;
  modal('Excluir campanha?', `<div class="settings-note campaign-delete-warning"><strong>Esta ação não pode ser desfeita.</strong><br>A campanha <b>${escapeHtml(campaign.name)}</b>, seus mapas, NPCs, handouts, álbuns e ${assets.length} arquivo(s) de mídia serão removidos deste navegador. Backups exportados anteriormente não serão apagados.</div>${isActiveCampaign ? '<p class="campaign-delete-active-note">Esta é a campanha que está aberta no momento. Depois da exclusão, o Astronic Tabletop abrirá outra campanha salva ou retornará à tela inicial.</p>' : ''}<div class="modal-actions"><button type="button" class="button button-secondary" data-modal-cancel>Cancelar</button><button type="button" class="button button-delete" id="confirmDeleteCampaignButton">Excluir campanha</button></div>`);
  $('confirmDeleteCampaignButton').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Excluindo…';
    try {
      await deleteCampaign(campaignId);
      closeModal();
      if (isActiveCampaign) {
        $('audioElement').pause();
        $('audioElement').removeAttribute('src');
        $('audioElement').load();
        state.selectedAudioId = null;
        if (!$('playerViewScreen').classList.contains('hidden')) closePlayerView();
        revokeObjectUrls();
        state.campaign = null;
        state.assets = [];
        state.pendingNpcId = null;
        state.markerMode = false;
        const remaining = await getCampaigns();
        if (remaining.length) await loadCampaign(remaining[0]);
        else {
          $('appShell').classList.add('hidden');
          $('welcomeScreen').classList.remove('hidden');
          state.activeView = 'map';
        }
      } else {
        await showCampaignList();
      }
      toast(`Campanha “${campaign.name}” excluída.`);
    } catch (error) {
      console.error(error);
      button.disabled = false;
      button.textContent = 'Tentar novamente';
      toast(error.message || 'Não foi possível excluir a campanha.');
    }
  });
}
function switchView(view) {
  if (!views[view]) return;
  state.activeView = view; setMarkerMode(false);
  document.querySelectorAll('.nav-button[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  document.querySelectorAll('.view-panel').forEach(panel => panel.classList.toggle('active-view', panel.id === `view-${view}`));
  $('topbarViewName').textContent = views[view]; renderView(view);
}
function renderAll() { $('sidebarCampaignName').textContent = state.campaign.name; $('topbarCampaignName').textContent = state.campaign.name; switchView(state.activeView); renderPlayerMonitor(); renderAudioDock(); }
function renderView(view) { if (view === 'map') renderMap(); if (view === 'npcs') renderNpcs(); if (view === 'library') renderLibrary(); if (view === 'audio') renderAudio(); if (view === 'handouts') renderHandouts(); }
document.querySelectorAll('.nav-button[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));

async function addFilesToCampaign(files, kindOverride = null) {
  if (!state.campaign) return [];
  const added = [];
  for (const file of [...files]) {
    const assetId = uid('asset'); const kind = kindOverride || inferKind(file);
    const extra = { kind, name: file.name, mime: file.type, size: file.size };
    await putAsset(state.campaign.id, assetId, file, extra);
    const record = { assetId, campaignId: state.campaign.id, ...extra, blob: file, createdAt: Date.now() };
    state.assets.push(record); added.push(record);
  }
  return added;
}
$('libraryFileInput').addEventListener('change', async event => {
  const files = [...(event.target.files || [])].filter(file => inferKind(file) !== 'audio');
  if (files.length) { await addFilesToCampaign(files); renderLibrary(); toast(`${files.length} arquivo(s) adicionado(s) à biblioteca.`); }
  event.target.value = '';
});
$('audioFilesInput').addEventListener('change', async event => {
  const files = [...(event.target.files || [])].filter(file => file.type.startsWith('audio/'));
  if (files.length) {
    await addFilesToCampaign(files, 'audio');
    // Upload never assigns tracks implicitly to whichever album happens to be open.
    state.audioFilter = { type: 'all', id: null };
    await persist();
    renderAudio();
    toast(`${files.length} faixa(s) adicionada(s) à biblioteca. Organize cada música em um álbum quando desejar.`);
  }
  event.target.value = '';
});
$('mapUploadInput').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (file) {
    const [asset] = await addFilesToCampaign([file], 'image');
    addMapRecord(asset.assetId, file.name.replace(/\.[^.]+$/, '') || 'Novo mapa');
  }
  event.target.value = '';
});

// MAPAS: edição local separada da tela publicada aos jogadores.
function getMap(mapId) { return state.campaign.maps.find(map => map.id === mapId) || null; }
function getEditorMap() { return getMap(state.campaign.editorMapId); }
function getMapAsset(map) { return map ? state.assets.find(asset => asset.assetId === map.assetId) : null; }
function mapMarkers(mapId) { return state.campaign.markers.filter(marker => marker.mapId === mapId); }

// SINCRONIZAÇÃO DA PRIMEIRA APRESENTAÇÃO: mapa + marcadores publicados.
const RTC_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const RTC_CHUNK_SIZE = 32 * 1024;
const RTC_BUFFER_HIGH_WATER = 1024 * 1024;

function makePublishedMapPayload() {
  const campaign = state.campaign;
  if (!campaign) return null;
  const shared = campaign.shared || {};
  const mapSnapshot = shared.mapSnapshot;
  const localMap = mapSnapshot?.id ? getMap(mapSnapshot.id) : null;
  const map = localMap && mapSnapshot?.assetId
    ? { id: localMap.id, name: mapSnapshot.name || localMap.name, assetId: mapSnapshot.assetId }
    : null;

  const visibleMarkers = map
    ? campaign.markers
      .filter(marker => marker.mapId === map.id && marker.visibleToPlayers && marker.publishedSnapshot)
      .map(marker => ({ ...marker.publishedSnapshot }))
    : [];

  const focusedNpcId = shared.npcPresentation?.npcId || shared.focusedNpcId;
  const npcRecord = focusedNpcId ? campaign.npcs.find(item => item.id === focusedNpcId) : null;
  const focusedNpc = shared.npcPresentation
    ? { ...shared.npcPresentation }
    : (npcRecord ? makeNpcPresentationSnapshot(npcRecord) : null);
  const focusedMarker = shared.focusedMarkerId
    ? (visibleMarkers.find(marker => marker.id === shared.focusedMarkerId) || null)
    : null;

  const handouts = campaign.handouts
    .filter(item => item.published && item.publishedSnapshot?.assetId)
    .map(item => {
      const snap = item.publishedSnapshot;
      const asset = state.assets.find(file => file.assetId === snap.assetId);
      return {
        id: item.id,
        title: snap.title || item.title || 'Handout',
        description: snap.description || '',
        assetId: snap.assetId,
        name: asset?.name || 'Arquivo',
        mime: asset?.mime || 'application/octet-stream',
        size: asset?.size || asset?.blob?.size || 0
      };
    });

  const presentationAssetId = shared.presentation?.type === 'asset' ? shared.presentation.assetId : null;
  const presentationAsset = presentationAssetId ? state.assets.find(asset => asset.assetId === presentationAssetId) : null;
  const presentation = presentationAsset ? {
    assetId: presentationAsset.assetId,
    title: shared.presentation.title || presentationAsset.name,
    name: presentationAsset.name,
    mime: presentationAsset.mime || presentationAsset.blob?.type || 'application/octet-stream',
    size: presentationAsset.size || presentationAsset.blob?.size || 0
  } : null;

  const audioTrack = shared.audioTrackId
    ? state.assets.find(asset => asset.assetId === shared.audioTrackId && asset.kind === 'audio')
    : null;
  const playback = shared.audioPlayback || {};
  const audio = audioTrack ? {
    assetId: audioTrack.assetId,
    name: audioTrack.name,
    mime: audioTrack.mime || audioTrack.blob?.type || 'audio/mpeg',
    size: audioTrack.size || audioTrack.blob?.size || 0,
    playing: !!playback.playing,
    volume: Math.max(0, Math.min(1, Number(playback.volume ?? 0.7))),
    currentTime: Math.max(0, Number(playback.currentTime || 0)),
    updatedAt: Number(playback.updatedAt || Date.now())
  } : null;

  // Somente os arquivos necessários para o conteúdo atualmente publicado são enviados.
  const assetIds = new Set();
  if (map?.assetId) assetIds.add(map.assetId);
  visibleMarkers.forEach(marker => { if (marker.portraitAssetId) assetIds.add(marker.portraitAssetId); });
  if (focusedNpc?.portraitAssetId) assetIds.add(focusedNpc.portraitAssetId);
  handouts.forEach(item => { if (item.assetId) assetIds.add(item.assetId); });
  if (presentation?.assetId) assetIds.add(presentation.assetId);
  if (audio?.assetId) assetIds.add(audio.assetId);

  const assetManifest = [...assetIds]
    .map(assetId => state.assets.find(asset => asset.assetId === assetId))
    .filter(asset => asset?.blob)
    .map(asset => ({
      assetId: asset.assetId,
      name: asset.name,
      mime: asset.mime || asset.blob.type || 'application/octet-stream',
      size: asset.size || asset.blob.size || 0,
      createdAt: asset.createdAt || 0
    }));

  const hasContent = !!(map || focusedNpc || focusedMarker || handouts.length || presentation || audio);
  if (!hasContent) return null;

  return {
    schemaVersion: 2,
    type: 'tabletop',
    publishedAt: Date.now(),
    campaignName: campaign.name,
    map,
    markers: visibleMarkers,
    mapStack: map ? (shared.mapStack || []).map(item => ({ id: item.id, name: item.name, assetId: item.assetId })) : [],
    focusedNpc,
    focusedMarker,
    handouts,
    presentation,
    audio,
    assetManifest
  };
}

function assetRevision(asset) {
  return `${asset?.assetId || ''}:${Number(asset?.size || asset?.blob?.size || 0)}:${Number(asset?.createdAt || 0)}`;
}

function getRemoteAssetUrl(assetId) {
  if (!assetId) return '';
  if (state.remoteAssetUrls.has(assetId)) return state.remoteAssetUrls.get(assetId);
  const asset = state.remoteAssets.get(assetId);
  if (!asset?.blob) return '';
  const url = URL.createObjectURL(asset.blob);
  state.remoteAssetUrls.set(assetId, url);
  return url;
}
function clearRemoteAssets() {
  state.remoteAssetUrls.forEach(url => URL.revokeObjectURL(url));
  state.remoteAssetUrls.clear();
  state.remoteAssets.clear();
  state.remoteIncomingTransfers.clear();
  state.remoteRequestedAssetRevisions.clear();
  state.remoteDismissedNpcId = null;
  state.remoteDismissedNpcPublishedAt = null;
}

function queueDataChannelSend(channel, data) {
  if (!channel || channel.readyState !== 'open') return Promise.resolve(false);
  const waitForBuffer = () => {
    if (channel.bufferedAmount <= RTC_BUFFER_HIGH_WATER) return Promise.resolve();
    return new Promise(resolve => {
      let finished = false;
      const finish = () => { if (finished) return; finished = true; clearTimeout(timeout); channel.removeEventListener('bufferedamountlow', finish); resolve(); };
      channel.bufferedAmountLowThreshold = Math.floor(RTC_BUFFER_HIGH_WATER / 2);
      const timeout = setTimeout(finish, 12000);
      channel.addEventListener('bufferedamountlow', finish, { once: true });
    });
  };
  return waitForBuffer().then(() => {
    if (channel.readyState !== 'open') return false;
    channel.send(data);
    return true;
  });
}

async function transferAssetToPeer(connection, asset) {
  const channel = connection?.channel;
  if (!channel || channel.readyState !== 'open' || !asset?.blob) throw new Error('O canal de mídia não está disponível.');
  const transferId = `${asset.assetId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
  const revision = assetRevision(asset);
  const started = await queueDataChannelSend(channel, JSON.stringify({
    kind: 'asset-start', transferId, revision, assetId: asset.assetId, name: asset.name,
    mime: asset.mime || asset.blob.type || 'application/octet-stream', size: asset.size || asset.blob.size
  }));
  if (!started) throw new Error('Não foi possível iniciar a transferência do arquivo.');
  for (let offset = 0; offset < asset.blob.size; offset += RTC_CHUNK_SIZE) {
    const chunk = await asset.blob.slice(offset, offset + RTC_CHUNK_SIZE).arrayBuffer();
    const sent = await queueDataChannelSend(channel, chunk);
    if (!sent) throw new Error('A conexão de mídia foi interrompida durante a transferência.');
  }
  const completed = await queueDataChannelSend(channel, JSON.stringify({ kind: 'asset-end', transferId }));
  if (!completed) throw new Error('A conexão foi interrompida antes da confirmação do arquivo.');
}

function sendPublishedAssetsToPeer(connection) {
  if (!connection?.channel || connection.channel.readyState !== 'open') return Promise.resolve(false);
  const manifest = state.lastPublishedMapState?.assetManifest || [];
  return queueDataChannelSend(connection.channel, JSON.stringify({ kind: 'asset-manifest', assets: manifest }))
    .catch(error => { console.warn('Não foi possível anunciar a biblioteca publicada:', error); return false; });
}

async function sendRequestedAssetToPeer(connection, assetId, requestedRevision = '') {
  const session = state.currentSession;
  const participant = (session?.participants || []).find(item => item.uid === connection?.playerUid && item.role === 'player');
  if (!participant || !connection?.channel || connection.channel.readyState !== 'open') return false;
  const publishedItem = (state.lastPublishedMapState?.assetManifest || []).find(item => item.assetId === assetId);
  if (!publishedItem) return false; // Nunca transmite arquivos que não estejam publicados.
  const asset = state.assets.find(item => item.assetId === assetId && item.blob);
  if (!asset) return false;
  const revision = assetRevision(asset);
  if (requestedRevision && requestedRevision !== revision) {
    await queueDataChannelSend(connection.channel, JSON.stringify({ kind: 'asset-error', assetId, revision: requestedRevision, message: 'A mídia publicada foi atualizada. Aguarde a nova apresentação.' }));
    return false;
  }
  connection.transferQueue = (connection.transferQueue || Promise.resolve())
    .catch(() => false)
    .then(async () => {
      if (!connection.channel || connection.channel.readyState !== 'open') return false;
      try {
        await transferAssetToPeer(connection, asset);
        return true;
      } catch (error) {
        console.warn(`Falha ao enviar ${asset.name || assetId} para ${participant.displayName || 'jogador'}:`, error);
        await queueDataChannelSend(connection.channel, JSON.stringify({ kind: 'asset-error', assetId, revision, message: error.message || 'Falha na transferência.' })).catch(() => false);
        return false;
      }
    });
  return connection.transferQueue;
}

async function sendPublishedAssetsToAllPeers() {
  const jobs = [...state.masterPeerConnections.values()].map(connection => sendPublishedAssetsToPeer(connection));
  await Promise.allSettled(jobs);
}

function findOpenPlayerDataChannel() {
  return [...state.playerPeerConnections.values()].reverse().find(item =>
    item.channel?.readyState === 'open' && item.pc?.connectionState === 'connected'
  ) || null;
}

function requestMissingPublishedAssets() {
  const connection = findOpenPlayerDataChannel();
  if (!connection) return false;
  const manifest = state.remotePublishedState?.assetManifest || [];
  for (const item of manifest) {
    const assetId = item?.assetId;
    if (!assetId) continue;
    const revision = `${assetId}:${Number(item.size || 0)}:${Number(item.createdAt || 0)}`;
    const existing = state.remoteAssets.get(assetId);
    if (existing && existing.revision === revision && Number(existing.size) === Number(item.size || 0)) continue;
    const incoming = [...state.remoteIncomingTransfers.values()].some(transfer => transfer.assetId === assetId && transfer.revision === revision);
    if (incoming) continue;
    if (state.remoteRequestedAssetRevisions.has(revision)) continue;
    try {
      connection.channel.send(JSON.stringify({ kind: 'asset-request', assetId, revision }));
      state.remoteRequestedAssetRevisions.add(revision);
    } catch (error) {
      console.warn('Não foi possível solicitar uma mídia ao mestre:', error);
      return false;
    }
  }
  return true;
}

function flushPendingPlayerMapActions() {
  const connection = findOpenPlayerDataChannel();
  if (!connection || !state.pendingPlayerMapActions.length) return;
  const pending = state.pendingPlayerMapActions.splice(0, 20);
  for (const packet of pending) {
    try { connection.channel.send(JSON.stringify(packet)); }
    catch (error) { state.pendingPlayerMapActions.unshift(packet); console.warn('Ação aguardando reconexão:', error); break; }
  }
}

function renderRemoteMapMarker(marker) {
  const portraitUrl = marker.type === 'npc' && marker.iconMode !== 'pin' ? getRemoteAssetUrl(marker.portraitAssetId) : '';
  const visual = portraitUrl ? `<img src="${portraitUrl}" alt="">` : (marker.type === 'npc' ? '♙' : (marker.icon || '⌖'));
  const cls = marker.type === 'npc' ? 'map-pin npc-pin' : `map-pin location-pin`;
  const style = `left:${Number(marker.x) || 0}%;top:${Number(marker.y) || 0}%`;
  const label = `<span class="map-pin-label">${escapeHtml(marker.name || 'Ponto')}</span>`;
  if (marker.playerClickable) return `<button type="button" class="${cls} player-map-pin" data-remote-marker="${escapeHtml(marker.id)}" style="${style}" aria-label="Abrir ${escapeHtml(marker.name || 'Ponto')}" title="Clique para explorar">${visual}${label}</button>`;
  return `<span class="${cls} player-map-pin locked" style="${style}" aria-label="${escapeHtml(marker.name || 'Ponto')} — interação bloqueada" title="O mestre ainda não liberou este ponto">${visual}${label}</span>`;
}

function remoteFilePreview(assetId, title, mime = '') {
  const asset = state.remoteAssets.get(assetId);
  const url = getRemoteAssetUrl(assetId);
  if (!asset || !url) {
    return `<div class="remote-file-loading"><span>⇣</span><strong>Recebendo arquivo…</strong><small>${escapeHtml(title || 'Material')}</small></div>`;
  }
  const actualMime = asset.mime || mime || '';
  if (actualMime.startsWith('image/')) return `<img class="player-presented-image" src="${url}" alt="${escapeHtml(title || asset.name)}">`;
  if (actualMime === 'application/pdf') return `<iframe class="player-presented-document" src="${url}" title="${escapeHtml(title || asset.name)}"></iframe>`;
  return `<a class="player-file-download" href="${url}" download="${escapeHtml(asset.name || title || 'arquivo')}">▤ Abrir ou baixar ${escapeHtml(asset.name || title || 'arquivo')}</a>`;
}

function buildRemotePublishedHtml() {
  const published = state.remotePublishedState;
  if (!published || published.type !== 'tabletop') {
    return `<div class="player-empty"><span>◉</span><strong>Nada apresentado ainda</strong><p>O mestre ainda não compartilhou conteúdos com a mesa.</p></div>`;
  }
  let html = '';
  const map = published.map || null;
  if (map) {
    const mapUrl = getRemoteAssetUrl(map.assetId);
    const pins = (published.markers || []).map(renderRemoteMapMarker).join('');
    const mapBody = mapUrl
      ? `<div class="player-map-canvas"><div class="monitor-map-stage"><img src="${mapUrl}" alt="${escapeHtml(map.name || 'Mapa apresentado')}">${pins}</div></div>`
      : `<div class="player-map-canvas remote-map-loading"><div class="player-empty"><span>⇣</span><strong>${state.remoteConnectionError ? 'Não foi possível receber o mapa' : 'Recebendo mapa…'}</strong><p>${state.remoteConnectionError ? 'A rede pode estar bloqueando a conexão direta. Avise o mestre para tentarmos outra rede.' : 'O mestre está transmitindo o arquivo para sua tela.'}</p></div></div>`;
    const hasMapMarkers = (published.markers || []).length > 0;
    const hasClickableMarkers = (published.markers || []).some(marker => marker.playerClickable);
    const markerHint = hasMapMarkers && !hasClickableMarkers ? '<small class="player-map-interaction-hint">Os pontos estão visíveis, mas o mestre ainda não liberou os cliques.</small>' : '';
    html += `<section class="player-map-card"><div class="monitor-section-title"><strong>${escapeHtml(map.name || 'Mapa da campanha')}</strong><span>MAPA DA CAMPANHA</span></div>${mapBody}${markerHint}${(published.mapStack || []).length ? '<button type="button" class="button button-secondary player-back-location" data-remote-map-back>← Voltar ao local anterior</button>' : ''}</section>`;
  }

  const isLocallyDismissedNpc = !!(published.focusedNpc
    && state.remoteDismissedNpcId === published.focusedNpc.npcId
    && state.remoteDismissedNpcPublishedAt === published.publishedAt);
  if (published.focusedNpc && !isLocallyDismissedNpc) {
    const npc = published.focusedNpc;
    const portraitUrl = getRemoteAssetUrl(npc.portraitAssetId);
    html += `<section class="monitor-section monitor-npc-card">${portraitUrl ? `<div class="monitor-npc-portrait-frame"><img src="${portraitUrl}" alt=""></div>` : ''}<div class="monitor-npc-copy"><div class="player-presentation-heading"><strong>${escapeHtml(npc.name || 'NPC')}</strong><button type="button" class="button button-secondary button-small" data-remote-close-npc="${escapeHtml(npc.npcId || '')}">Fechar</button></div>${npc.role ? `<small class="remote-npc-role">${escapeHtml(npc.role)}</small>` : ''}<p>${escapeHtml(npc.publicDescription || '')}</p>${npc.publicRelations ? `<small>Relações: ${escapeHtml(npc.publicRelations)}</small>` : ''}</div></section>`;
  }

  if (published.focusedMarker) {
    const marker = published.focusedMarker;
    html += `<section class="monitor-section"><div class="monitor-section-title"><strong>${escapeHtml(marker.name || 'Localidade')}</strong><span>LOCALIDADE</span></div><p class="monitor-location-description">${escapeHtml(marker.description || 'Nenhuma descrição foi adicionada.')}</p></section>`;
  }

  const handouts = published.handouts || [];
  if (handouts.length) {
    html += `<section class="monitor-section"><div class="monitor-section-title"><strong>Handouts apresentados</strong><span>${handouts.length}</span></div><div class="player-handouts">${handouts.map(item => {
      const available = state.remoteAssets.has(item.assetId);
      return `<button type="button" class="monitor-handout player-handout-button" data-remote-open-handout="${escapeHtml(item.id)}" ${available ? '' : 'disabled'}><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.description || 'Material compartilhado pelo mestre')}</small><span>${available ? 'Abrir material ↗' : 'Recebendo arquivo…'}</span></button>`;
    }).join('')}</div></section>`;
  }

  const openedHandout = handouts.find(item => item.id === state.remoteOpenHandoutId);
  if (openedHandout) {
    html += `<section class="monitor-section player-open-handout"><div class="player-presentation-heading"><strong>${escapeHtml(openedHandout.title)}</strong><button type="button" class="button button-secondary button-small" data-remote-close-handout>Fechar documento</button></div><div class="player-presentation-body">${remoteFilePreview(openedHandout.assetId, openedHandout.title, openedHandout.mime)}</div><small>${escapeHtml(openedHandout.description || '')}</small></section>`;
  }

  if (published.presentation?.assetId) {
    const item = published.presentation;
    html += `<section class="monitor-section player-presented-section"><div class="monitor-section-title"><strong>${escapeHtml(item.title || item.name || 'Material apresentado')}</strong><span>MATERIAL APRESENTADO</span></div><div class="player-presentation-body">${remoteFilePreview(item.assetId, item.title || item.name, item.mime)}</div></section>`;
  }

  if (published.audio) {
    const audio = published.audio;
    const received = state.remoteAssets.has(audio.assetId);
    const status = !received ? 'Recebendo música…' : (audio.playing ? 'Reprodução controlada pelo mestre' : 'Em pausa · controlada pelo mestre');
    html += `<section class="monitor-audio player-audio-status"><span class="monitor-audio-icon">♫</span><div><strong>${escapeHtml(audio.name || 'Trilha sonora')}</strong><small>${status}</small></div>${!state.remoteAudioActivated ? `<button type="button" class="button button-secondary button-small" data-remote-enable-audio ${received ? '' : 'disabled'}>${received ? 'Ativar áudio' : 'Aguarde'}</button>` : '<span class="monitor-audio-live">Áudio ativado</span>'}</section>`;
  }

  if (!html) html = `<div class="player-empty"><span>◉</span><strong>Nada apresentado ainda</strong><p>O mestre ainda não compartilhou conteúdos com a mesa.</p></div>`;
  return html;
}

function getRemoteAudioElement() {
  if (!state.remoteAudioElement) {
    state.remoteAudioElement = new Audio();
    state.remoteAudioElement.preload = 'auto';
  }
  return state.remoteAudioElement;
}

function stopRemoteAudio(resetActivation = false) {
  const audio = state.remoteAudioElement;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  state.remoteAudioAssetId = null;
  if (resetActivation) state.remoteAudioActivated = false;
}

async function applyRemoteAudioState(userGesture = false) {
  const publishedAudio = state.remotePublishedState?.audio;
  if (!publishedAudio) {
    stopRemoteAudio(false);
    return;
  }
  const asset = state.remoteAssets.get(publishedAudio.assetId);
  if (!asset?.blob) return;
  const audio = getRemoteAudioElement();
  const sourceUrl = getRemoteAssetUrl(publishedAudio.assetId);
  const sourceChanged = state.remoteAudioAssetId !== publishedAudio.assetId || audio.src !== sourceUrl;
  if (sourceChanged) {
    audio.pause();
    audio.src = sourceUrl;
    audio.load();
    state.remoteAudioAssetId = publishedAudio.assetId;
  }
  audio.volume = Math.max(0, Math.min(1, Number(publishedAudio.volume ?? 0.7)));
  const elapsed = publishedAudio.playing ? Math.max(0, Date.now() - Number(publishedAudio.updatedAt || Date.now())) / 1000 : 0;
  const targetTime = Math.max(0, Number(publishedAudio.currentTime || 0) + elapsed);
  const seekToPublishedTime = () => {
    if (audio.readyState >= 1 && Math.abs(audio.currentTime - targetTime) > 1.25) {
      try { audio.currentTime = Math.min(targetTime, Number.isFinite(audio.duration) ? audio.duration : targetTime); } catch { /* metadados ainda não estão prontos */ }
    }
  };
  if (audio.readyState >= 1) seekToPublishedTime();
  else if (sourceChanged) audio.addEventListener('loadedmetadata', seekToPublishedTime, { once: true });
  if (publishedAudio.playing && (state.remoteAudioActivated || userGesture)) {
    if (userGesture) state.remoteAudioActivated = true;
    try { if (audio.paused) await audio.play(); }
    catch (error) { console.warn('O navegador bloqueou a reprodução sincronizada:', error); }
  } else if (!publishedAudio.playing) {
    audio.pause();
  }
}


function bindRemotePublishedInteractions(root) {
  root.querySelectorAll('[data-remote-marker]').forEach(button => button.addEventListener('click', () => sendPlayerMapAction({ type: 'marker-click', markerId: button.dataset.remoteMarker })));
  root.querySelectorAll('[data-remote-map-back]').forEach(button => button.addEventListener('click', () => sendPlayerMapAction({ type: 'map-back' })));
  root.querySelectorAll('[data-remote-open-handout]').forEach(button => button.addEventListener('click', () => {
    const handout = (state.remotePublishedState?.handouts || []).find(item => item.id === button.dataset.remoteOpenHandout);
    if (!handout || !state.remoteAssets.has(handout.assetId)) return;
    state.remoteOpenHandoutId = handout.id;
    renderRemotePlayerSession();
  }));
  root.querySelectorAll('[data-remote-close-handout]').forEach(button => button.addEventListener('click', () => {
    state.remoteOpenHandoutId = null;
    renderRemotePlayerSession();
  }));
  root.querySelectorAll('[data-remote-close-npc]').forEach(button => button.addEventListener('click', () => {
    sendPlayerMapAction({ type: 'npc-dismiss', npcId: button.dataset.remoteCloseNpc });
  }));
  root.querySelectorAll('[data-remote-enable-audio]').forEach(button => button.addEventListener('click', async () => {
    state.remoteAudioActivated = true;
    await applyRemoteAudioState(true);
    renderRemotePlayerSession();
  }));
}

function sendPlayerMapAction(action) {
  const packet = { kind: 'player-map-action', requestId: uid('action'), action };
  if (action?.type === 'npc-dismiss') {
    state.remoteDismissedNpcId = action.npcId || null;
    state.remoteDismissedNpcPublishedAt = state.remotePublishedState?.publishedAt ?? null;
    renderRemotePlayerSession();
  }
  const connection = findOpenPlayerDataChannel();
  if (!connection) {
    if (state.pendingPlayerMapActions.length < 20) state.pendingPlayerMapActions.push(packet);
    toast('Ação guardada. Será enviada quando a conexão com o mestre estiver pronta.');
    return false;
  }
  try {
    connection.channel.send(JSON.stringify(packet));
    return true;
  } catch (error) {
    if (state.pendingPlayerMapActions.length < 20) state.pendingPlayerMapActions.push(packet);
    console.warn('Não foi possível enviar a ação ao mestre:', error);
    toast('A conexão oscilou. A ação será tentada novamente.');
    return false;
  }
}

async function handleRemotePlayerMapAction(playerUid, action) {
  if (state.role !== 'master' || !state.campaign || !state.currentSession || state.currentSession.campaignId !== state.campaign.id) {
    return { ok: false, message: 'A sessão do mestre não está disponível.' };
  }
  const participant = (state.currentSession.participants || []).find(item => item.uid === playerUid && item.role === 'player');
  if (!participant) return { ok: false, message: 'Sua conta não está registrada como participante desta sessão.' };
  if (action?.type === 'marker-click') {
    const marker = state.campaign.markers.find(item => item.id === action.markerId);
    const view = marker?.publishedSnapshot;
    if (!marker || marker.mapId !== state.campaign.shared.mapId || !marker.visibleToPlayers || !view?.playerClickable) {
      return { ok: false, message: 'Este ponto está bloqueado ou não foi liberado pelo mestre.' };
    }
    if (view.type === 'npc') {
      state.campaign.shared.focusedNpcId = view.npcId;
      state.campaign.shared.npcPresentation = { npcId: view.npcId, name: view.name, role: view.role || '', portraitAssetId: view.portraitAssetId || null, publicDescription: view.publicDescription || '', publicRelations: view.publicRelations || '' };
      state.campaign.shared.focusedMarkerId = null;
    } else if (view.childMapId && getMap(view.childMapId)) {
      if (state.campaign.shared.mapSnapshot) state.campaign.shared.mapStack.push(state.campaign.shared.mapSnapshot);
      const child = getMap(view.childMapId);
      state.campaign.shared.mapId = child.id;
      state.campaign.shared.mapSnapshot = { id: child.id, assetId: child.assetId, name: child.name };
      state.campaign.shared.focusedNpcId = null;
      state.campaign.shared.npcPresentation = null;
      state.campaign.shared.focusedMarkerId = null;
    } else {
      state.campaign.shared.focusedMarkerId = marker.id;
      state.campaign.shared.focusedNpcId = null;
      state.campaign.shared.npcPresentation = null;
    }
  } else if (action?.type === 'npc-dismiss') {
    const focusedId = state.campaign.shared.npcPresentation?.npcId || state.campaign.shared.focusedNpcId;
    if (!focusedId || focusedId !== action.npcId) return { ok: false, message: 'Este personagem já não está aberto.' };
    state.campaign.shared.focusedNpcId = null;
    state.campaign.shared.npcPresentation = null;
    state.campaign.shared.focusedMarkerId = null;
  } else if (action?.type === 'map-back') {
    const previous = state.campaign.shared.mapStack.pop();
    if (!previous) return { ok: false, message: 'Não há um mapa anterior para voltar.' };
    state.campaign.shared.mapId = previous.id;
    state.campaign.shared.mapSnapshot = previous;
    state.campaign.shared.focusedNpcId = null;
    state.campaign.shared.npcPresentation = null;
    state.campaign.shared.focusedMarkerId = null;
  } else return { ok: false, message: 'Ação não reconhecida.' };
  await persist();
  renderPlayerMonitor();
  await publishCurrentMapToPlayers({ silent: true });
  return { ok: true, message: 'Ação aplicada pelo mestre.' };
}

function attachPeerChannelHandlers(connection, channel, isMasterSide) {
  connection.channel = channel;
  channel.binaryType = 'arraybuffer';
  channel.onopen = () => {
    if (isMasterSide) sendPublishedAssetsToPeer(connection);
    else {
      toast('Conexão de mídia estabelecida com o mestre.');
      flushPendingPlayerMapActions();
      requestMissingPublishedAssets();
    }
  };
  channel.onclose = () => {
    connection.channel = null;
    if (!isMasterSide) {
      const interrupted = state.remoteIncomingTransfers.get(connection.connectionId);
      if (interrupted?.revision) state.remoteRequestedAssetRevisions.delete(interrupted.revision);
      state.remoteIncomingTransfers.delete(connection.connectionId);
      state.remoteRequestedAssetRevisions.clear();
    }
  };
  channel.onmessage = async event => {
    if (typeof event.data === 'string') {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (isMasterSide && message.kind === 'player-map-action') {
        let result;
        try { result = await handleRemotePlayerMapAction(connection.playerUid, message.action); }
        catch (error) { result = { ok: false, message: error?.message || 'Não foi possível concluir a ação.' }; }
        if (message.requestId) {
          await queueDataChannelSend(channel, JSON.stringify({ kind: 'player-action-result', requestId: message.requestId, ...result })).catch(() => false);
        }
      } else if (!isMasterSide && message.kind === 'player-action-result') {
        if (!message.ok) {
          if (state.remoteDismissedNpcId) {
            state.remoteDismissedNpcId = null;
            state.remoteDismissedNpcPublishedAt = null;
            renderRemotePlayerSession();
          }
          toast(message.message || 'O mestre não conseguiu concluir essa ação.');
        }
      } else if (isMasterSide && message.kind === 'asset-request') {
        await sendRequestedAssetToPeer(connection, message.assetId, message.revision || '');
      } else if (!isMasterSide && message.kind === 'asset-manifest') {
        requestMissingPublishedAssets();
      } else if (!isMasterSide && message.kind === 'asset-error') {
        if (message.revision) state.remoteRequestedAssetRevisions.delete(message.revision);
        state.remoteConnectionError = true;
        console.warn('O mestre não conseguiu enviar uma mídia:', message.message || message.assetId);
        renderRemotePlayerSession();
      } else if (!isMasterSide && message.kind === 'asset-start') {
        // asset-start apenas abre a transferência. Os bytes chegam em mensagens
        // binárias subsequentes e só são montados quando asset-end é recebido.
        state.remoteIncomingTransfers.set(connection.connectionId, { ...message, chunks: [], received: 0 });
        state.remoteConnectionError = false;
      } else if (!isMasterSide && message.kind === 'asset-end') {
        const transfer = state.remoteIncomingTransfers.get(connection.connectionId);
        if (!transfer || transfer.transferId !== message.transferId) return;
        const blob = new Blob(transfer.chunks, { type: transfer.mime || 'application/octet-stream' });
        const expectedSize = Number(transfer.size || 0);
        if (expectedSize > 0 && blob.size !== expectedSize) {
          state.remoteIncomingTransfers.delete(connection.connectionId);
          if (transfer.revision) state.remoteRequestedAssetRevisions.delete(transfer.revision);
          state.remoteConnectionError = true;
          console.warn(`Arquivo recebido incompleto: ${transfer.name || transfer.assetId} (${blob.size}/${expectedSize} bytes).`);
          renderRemotePlayerSession();
          return;
        }
        state.remoteConnectionError = false;
        const previousUrl = state.remoteAssetUrls.get(transfer.assetId);
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        state.remoteAssetUrls.delete(transfer.assetId);
        state.remoteAssets.set(transfer.assetId, {
          assetId: transfer.assetId,
          name: transfer.name,
          mime: transfer.mime,
          size: blob.size,
          revision: transfer.revision || `${transfer.assetId}:${blob.size}:0`,
          blob
        });
        state.remoteIncomingTransfers.delete(connection.connectionId);
        if (transfer.revision) state.remoteRequestedAssetRevisions.delete(transfer.revision);
        await applyRemoteAudioState();
        renderRemotePlayerSession();
        requestMissingPublishedAssets();
      }
    } else if (!isMasterSide) {
      const transfer = state.remoteIncomingTransfers.get(connection.connectionId);
      if (transfer) { transfer.chunks.push(event.data); transfer.received += event.data.byteLength || event.data.size || 0; }
    }
  };
}

async function createMasterPeerForPlayer(session, participant) {
  const playerUid = participant.uid;
  if (!playerUid || state.masterPeerConnections.has(playerUid) || !window.RTCPeerConnection) return;
  const connectionId = uid('rtc');
  const pc = new RTCPeerConnection({ iceServers: RTC_ICE_SERVERS });
  const connection = { pc, channel: null, playerUid, connectionId, unsubscribers: [], candidateIds: new Set(), sentAssets: new Set() };
  state.masterPeerConnections.set(playerUid, connection);
  const channel = pc.createDataChannel('astronic-media', { ordered: true });
  attachPeerChannelHandlers(connection, channel, true);
  pc.onicecandidate = event => { if (event.candidate) addFirebaseRtcCandidate(session.id, 'master', playerUid, connectionId, event.candidate.toJSON()).catch(error => console.warn('ICE mestre:', error)); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') toast(`A conexão direta com ${participant.displayName || 'um jogador'} falhou. A rede pode exigir um servidor TURN.`);
    if (['failed', 'closed'].includes(pc.connectionState)) console.warn(`Conexão de mídia com ${participant.displayName || 'jogador'}: ${pc.connectionState}`);
  };
  connection.unsubscribers.push(watchFirebaseRtcAnswer(session.id, playerUid, connectionId, async answer => {
    if (!answer || pc.remoteDescription) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: answer.type, sdp: answer.sdp }));
      const pending = connection.pendingCandidates || [];
      connection.pendingCandidates = [];
      for (const candidate of pending) await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(error => console.warn('ICE pendente:', error));
    } catch (error) { console.error('Falha ao receber resposta WebRTC:', error); }
  }, error => console.warn('Resposta WebRTC:', error)));
  connection.unsubscribers.push(watchFirebaseRtcCandidates(session.id, 'player', playerUid, connectionId, async candidates => {
    for (const [candidateId, candidate] of Object.entries(candidates)) {
      if (connection.candidateIds.has(candidateId)) continue;
      connection.candidateIds.add(candidateId);
      if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(error => console.warn('ICE jogador:', error));
      else (connection.pendingCandidates ||= []).push(candidate);
    }
  }, error => console.warn('Candidatos WebRTC:', error)));
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await writeFirebaseRtcOffer(session.id, playerUid, connectionId, { type: pc.localDescription.type, sdp: pc.localDescription.sdp, createdAt: Date.now(), masterUid: state.user.uid });
  } catch (error) {
    console.error('Não foi possível iniciar WebRTC com o jogador:', error);
    closeRtcConnection(connection);
    state.masterPeerConnections.delete(playerUid);
  }
}

function closeRtcConnection(connection) {
  if (!connection) return;
  (connection.unsubscribers || []).forEach(unsubscribe => { try { unsubscribe(); } catch { /* já encerrado */ } });
  try { connection.channel?.close(); } catch { /* já fechado */ }
  try { connection.pc?.close(); } catch { /* já fechado */ }
}

async function ensureMasterPeerConnections(session, participants) {
  if (state.role !== 'master' || !session?.id || state.currentSession?.id !== session.id) return;
  const players = participants.filter(item => item.role === 'player' && item.uid);
  const playerIds = new Set(players.map(item => item.uid));
  for (const [playerUid, connection] of state.masterPeerConnections) {
    if (!playerIds.has(playerUid)) {
      closeRtcConnection(connection);
      state.masterPeerConnections.delete(playerUid);
      removeFirebaseRtcPlayerSignals(session.id, playerUid).catch(error => console.warn('Não foi possível limpar sinalização WebRTC antiga:', error));
    }
  }
  for (const participant of players) await createMasterPeerForPlayer(session, participant);
}

async function startPlayerPeerConnection(session, connectionId, offer) {
  if (state.playerPeerConnections.has(connectionId) || !window.RTCPeerConnection) return;
  const pc = new RTCPeerConnection({ iceServers: RTC_ICE_SERVERS });
  const connection = { pc, channel: null, playerUid: state.user.uid, connectionId, unsubscribers: [], candidateIds: new Set(), pendingCandidates: [] };
  state.playerPeerConnections.set(connectionId, connection);
  pc.ondatachannel = event => attachPeerChannelHandlers(connection, event.channel, false);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      state.remoteConnectionError = true;
      closeRtcConnection(connection);
      state.playerPeerConnections.delete(connectionId);
      renderRemotePlayerSession();
    }
    if (pc.connectionState === 'connected') { state.remoteConnectionError = false; renderRemotePlayerSession(); flushPendingPlayerMapActions(); requestMissingPublishedAssets(); }
  };
  pc.onicecandidate = event => { if (event.candidate) addFirebaseRtcCandidate(session.id, 'player', state.user.uid, connectionId, event.candidate.toJSON()).catch(error => console.warn('ICE jogador:', error)); };
  connection.unsubscribers.push(watchFirebaseRtcCandidates(session.id, 'master', state.user.uid, connectionId, async candidates => {
    for (const [candidateId, candidate] of Object.entries(candidates)) {
      if (connection.candidateIds.has(candidateId)) continue;
      connection.candidateIds.add(candidateId);
      if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(error => console.warn('ICE mestre:', error));
      else connection.pendingCandidates.push(candidate);
    }
  }, error => console.warn('Candidatos WebRTC:', error)));
  try {
    await pc.setRemoteDescription(new RTCSessionDescription({ type: offer.type, sdp: offer.sdp }));
    for (const candidate of connection.pendingCandidates.splice(0)) await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(error => console.warn('ICE inicial:', error));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await writeFirebaseRtcAnswer(session.id, state.user.uid, connectionId, { type: pc.localDescription.type, sdp: pc.localDescription.sdp, answeredAt: Date.now() });
  } catch (error) {
    console.error('Falha ao responder oferta WebRTC:', error);
    closeRtcConnection(connection);
    state.playerPeerConnections.delete(connectionId);
  }
}

function startPlayerRtcListener(session) {
  if (!session?.id || !state.user?.uid) return;
  if (state.playerRtcOffersUnsubscribe) state.playerRtcOffersUnsubscribe();
  state.playerRtcOfferIds.clear();
  state.playerRtcOffersUnsubscribe = watchFirebaseRtcOffers(session.id, state.user.uid, offers => {
    for (const [connectionId, offer] of Object.entries(offers || {})) {
      if (state.playerRtcOfferIds.has(connectionId)) continue;
      if (!offer?.sdp || (offer.createdAt && offer.createdAt < (session.joinedAt || 0) - 5000)) continue;
      state.playerRtcOfferIds.add(connectionId);
      startPlayerPeerConnection(session, connectionId, offer);
    }
  }, error => console.warn('Ofertas WebRTC:', error));
}

async function publishCurrentMapToPlayers(options = {}) {
  const session = state.currentSession;
  if (!session?.id || session.status !== 'active' || session.campaignId !== state.campaign?.id) {
    if (!options.silent) toast('Crie uma sessão online antes de apresentar conteúdo aos jogadores.');
    return false;
  }
  const payload = makePublishedMapPayload();
  await publishFirebaseState(session.id, payload);
  state.lastPublishedMapState = payload;
  if (payload) await sendPublishedAssetsToAllPeers();
  if (!options.silent) toast(payload ? 'Conteúdo atualizado para os jogadores.' : 'Apresentação limpa para os jogadores.');
  return !!payload;
}

async function hidePublishedMapFromPlayers(options = {}) {
  const session = state.currentSession;
  if (session?.id && session.status === 'active' && session.campaignId === state.campaign?.id) {
    await publishCurrentMapToPlayers({ silent: true });
  }
  if (!options.silent) toast('Mapa ocultado dos jogadores.');
}

async function startMasterSyncForSession(session) {
  if (!session?.id || state.role !== 'master') return;
  state.lastPublishedMapState = makePublishedMapPayload();
  await publishFirebaseState(session.id, state.lastPublishedMapState || null);
  if (state.sessionParticipantsUnsubscribe) state.sessionParticipantsUnsubscribe();
  state.sessionParticipantsUnsubscribe = watchFirebaseParticipants(session.id, participants => {
    if (state.currentSession?.id !== session.id) return;
    state.currentSession.participants = participants;
    updateParticipantList(participants);
    ensureMasterPeerConnections(session, participants);
  }, error => { console.error(error); toast('Não foi possível atualizar os participantes. Confira as regras do banco.'); });
  state.sessionListenerId = session.id;
}

function attachRemoteMapStateListener(session) {
  if (state.playerPublishedStateUnsubscribe) state.playerPublishedStateUnsubscribe();
  state.remotePublishedState = null;
  state.playerPublishedStateUnsubscribe = watchFirebasePublishedState(session.id, published => {
    state.remotePublishedState = published || null;
    const publishedNpcId = published?.focusedNpc?.npcId || null;
    if (!published || published.publishedAt !== state.remoteDismissedNpcPublishedAt || publishedNpcId !== state.remoteDismissedNpcId) {
      state.remoteDismissedNpcId = null;
      state.remoteDismissedNpcPublishedAt = null;
    }
    if (!published) { state.remoteOpenHandoutId = null; stopRemoteAudio(false); state.remoteRequestedAssetRevisions.clear(); }
    else {
      if (state.remoteOpenHandoutId && !(published.handouts || []).some(item => item.id === state.remoteOpenHandoutId)) state.remoteOpenHandoutId = null;
      applyRemoteAudioState().catch(error => console.warn('Áudio remoto:', error));
      requestMissingPublishedAssets();
    }
    renderRemotePlayerSession();
  }, error => {
    console.error('Falha ao receber conteúdo publicado:', error);
    $('playerScreenBody').innerHTML = '<div class="player-empty"><strong>Não foi possível receber a apresentação</strong><p>Confira a conexão com a sessão e as regras do Realtime Database.</p></div>';
  });
}

function renderMapSwitcher() {
  const maps = state.campaign.maps;
  $('mapSwitcher').innerHTML = maps.length ? maps.map(map => `<button class="map-switch-chip ${map.id === state.campaign.editorMapId ? 'active' : ''}" data-switch-map="${map.id}">${escapeHtml(map.name)}${state.campaign.shared.mapId === map.id ? '<i>● Ao vivo</i>' : ''}</button>`).join('') : '<span class="muted-label">Nenhum mapa cadastrado ainda.</span>';
  $('mapSwitcher').querySelectorAll('[data-switch-map]').forEach(button => button.addEventListener('click', () => { state.campaign.editorMapId = button.dataset.switchMap; state.campaign.editorMapStack = []; persist().then(renderMap); }));
}
function renderMap() {
  const map = getEditorMap(); const asset = getMapAsset(map); const markers = map ? mapMarkers(map.id) : [];
  renderMapSwitcher(); $('mapTitle').textContent = map?.name || 'Nenhum mapa criado'; $('mapSubtitle').textContent = asset ? `${markers.length} ponto(s) · edição privada do mestre` : 'Adicione um mapa para começar';
  $('mapMarkerCount').textContent = `${markers.length} ponto(s) neste mapa`;
  $('mapSideCount').textContent = markers.length; $('mapBackButton').classList.toggle('hidden', !state.campaign.editorMapStack.length);
  const isShared = !!map && state.campaign.shared.mapId === map.id;
  $('shareMapButton').disabled = !map; $('shareMapButton').textContent = isShared ? 'Atualizar apresentação' : 'Apresentar aos jogadores'; $('shareMapButton').classList.toggle('button-secondary', isShared); $('shareMapButton').classList.toggle('button-primary', !isShared); $('hideMapButton').classList.toggle('hidden', !isShared);
  $('mapShareStatus').textContent = isShared ? 'Este é o mapa que os jogadores estão vendo.' : 'Alterações aqui não aparecem para os jogadores até serem apresentadas.';
  if (!asset) {
    $('mapCanvas').className = 'map-canvas empty-map'; $('mapCanvas').innerHTML = `<div class="empty-map-content"><span class="empty-map-icon">⌖</span><strong>${map ? 'Imagem do mapa indisponível' : 'Seu mapa aparecerá aqui'}</strong><p>${map ? 'Edite este mapa para selecionar outra imagem.' : 'Crie um mapa e escolha uma imagem da biblioteca.'}</p><button id="emptyManageMapsButtonInner" class="button button-secondary">Gerenciar mapas</button></div>`;
    $('emptyManageMapsButtonInner').addEventListener('click', showMapManager);
  } else {
    $('mapCanvas').className = 'map-canvas has-map';
    $('mapCanvas').innerHTML = `<div class="map-stage" id="mapStage"><img id="mapDisplayImage" src="${getAssetUrl(asset)}" alt="${escapeHtml(map.name)}">${markers.map(marker => markerHtml(marker, false)).join('')}</div>`;
    $('mapStage').addEventListener('click', onMapStageClick);
    $('mapStage').querySelectorAll('[data-marker-id]').forEach(pin => pin.addEventListener('click', event => { event.stopPropagation(); showMarkerDetails(pin.dataset.markerId); }));
  }
  $('mapMarkerList').innerHTML = markers.length ? markers.map(marker => {
    const npc = marker.type === 'npc' ? state.campaign.npcs.find(item => item.id === marker.npcId) : null;
    const portraitId = npcPortraitAssetId(npc); const portrait = portraitId ? state.assets.find(item => item.assetId === portraitId) : null;
    const icon = portrait && marker.iconMode !== 'pin' ? `<img src="${getAssetUrl(portrait)}" alt="">` : (marker.type === 'npc' ? '♙' : (marker.icon || '⌖'));
    return `<article class="marker-control-card"><div class="marker-control-top"><span class="marker-list-icon">${icon}</span><div class="marker-list-info"><strong>${escapeHtml(marker.name)}</strong><small>${marker.type === 'npc' ? 'NPC' : 'Localidade'} · ${marker.visibleToPlayers ? 'Apresentado' : 'Oculto'}</small></div><button class="mini-button" data-marker-detail="${marker.id}">Editar</button></div><div class="marker-control-actions"><button class="mini-button ${marker.visibleToPlayers ? 'active' : ''}" data-marker-publish="${marker.id}">${marker.visibleToPlayers ? 'Ocultar' : 'Apresentar'}</button>${marker.visibleToPlayers ? `<button class="mini-button" data-marker-refresh="${marker.id}">Atualizar</button>` : ''}<button class="mini-button ${marker.playerClickable ? 'active' : ''}" data-marker-lock="${marker.id}">${marker.playerClickable ? 'Bloquear clique' : 'Liberar clique'}</button></div></article>`;
  }).join('') : '<div class="empty-list">Nenhum ponto neste mapa. Clique em “Adicionar ponto” para começar.</div>';
  $('mapMarkerList').querySelectorAll('[data-marker-detail]').forEach(button => button.addEventListener('click', () => showMarkerDetails(button.dataset.markerDetail)));
  $('mapMarkerList').querySelectorAll('[data-marker-publish]').forEach(button => button.addEventListener('click', () => toggleMarkerPublished(button.dataset.markerPublish)));
  $('mapMarkerList').querySelectorAll('[data-marker-refresh]').forEach(button => button.addEventListener('click', () => refreshMarkerPresentation(button.dataset.markerRefresh)));
  $('mapMarkerList').querySelectorAll('[data-marker-lock]').forEach(button => button.addEventListener('click', () => toggleMarkerClickable(button.dataset.markerLock)));
}
function markerHtml(marker, playerMode) {
  const view = playerMode ? (marker.publishedSnapshot || {}) : marker;
  if (playerMode && (!marker.visibleToPlayers || !marker.publishedSnapshot)) return '';
  const npc = (playerMode ? view.type : marker.type) === 'npc' ? state.campaign.npcs.find(item => item.id === (playerMode ? view.npcId : marker.npcId)) : null;
  const portraitAssetId = playerMode ? view.portraitAssetId : npcPortraitAssetId(npc);
  const portrait = portraitAssetId ? state.assets.find(asset => asset.assetId === portraitAssetId) : null;
  const type = playerMode ? view.type : marker.type;
  const iconMode = playerMode ? view.iconMode : marker.iconMode;
  const usePortrait = type === 'npc' && iconMode !== 'pin' && portrait;
  const name = playerMode ? view.name : marker.name;
  const cls = type === 'npc' ? 'map-pin npc-pin' : `map-pin location-pin icon-${escapeHtml(playerMode ? view.icon || 'pin' : marker.icon || 'pin')}`;
  const icon = usePortrait ? `<img src="${getAssetUrl(portrait)}" alt="">` : (type === 'npc' ? '♙' : (playerMode ? view.icon || '⌖' : marker.icon || '⌖'));
  const inner = `${icon}<span class="map-pin-label">${escapeHtml(name)}</span>`;
  const style = `left:${playerMode ? view.x : marker.x}%;top:${playerMode ? view.y : marker.y}%`;
  if (playerMode) {
    if (view.playerClickable) return `<button type="button" class="${cls} player-map-pin" data-player-marker="${marker.id}" style="${style}" aria-label="${escapeHtml(name)}">${inner}</button>`;
    return `<span class="${cls} player-map-pin locked" style="${style}" aria-label="${escapeHtml(name)}">${inner}</span>`;
  }
  return `<button type="button" class="${cls}" data-marker-id="${marker.id}" style="${style}" aria-label="${escapeHtml(name)}">${inner}</button>`;
}
function addMapRecord(assetId, name) {
  const map = { id: uid('map'), assetId, name: name.trim() || 'Novo mapa' };
  state.campaign.maps.push(map); state.campaign.editorMapId = map.id; state.campaign.editorMapStack = [];
  persist().then(() => { renderMap(); switchView('map'); toast('Mapa adicionado.'); });
}
function showMapManager() {
  const maps = state.campaign.maps;
  const list = maps.length ? maps.map(map => `<div class="map-manager-row"><label class="map-manager-check"><input type="checkbox" class="map-bulk-check" value="${map.id}"></label><div><strong>${escapeHtml(map.name)}</strong><small>${escapeHtml(getMapAsset(map)?.name || 'Imagem não encontrada')} · ${mapMarkers(map.id).length} ponto(s)</small></div><div class="map-manager-actions"><button type="button" class="mini-button" data-map-select="${map.id}">Abrir</button><button type="button" class="mini-button" data-map-edit="${map.id}">Editar</button><button type="button" class="mini-button danger" data-map-delete="${map.id}">Excluir</button></div></div>`).join('') : emptyState('⌖','Nenhum mapa cadastrado','Adicione um mapa para começar a montar sua campanha.');
  modal('Gerenciar mapas', `<div class="bulk-manager-toolbar"><label><input type="checkbox" id="mapSelectAll"> Selecionar todos</label><span id="mapSelectedCount">0 selecionado(s)</span></div><div class="map-manager-list">${list}</div><div class="modal-actions map-manager-modal-actions"><button type="button" class="button button-secondary" data-modal-cancel>Fechar</button><button type="button" class="button button-primary" id="deleteSelectedMaps" ${maps.length ? '' : 'disabled'}>Excluir selecionados</button><button type="button" class="button button-secondary" id="addMapFromManager">＋ Adicionar mapa</button></div>`);
  const checks = [...$('modalBody').querySelectorAll('.map-bulk-check')];
  const update = () => { const count = checks.filter(item => item.checked).length; $('mapSelectedCount').textContent = `${count} selecionado(s)`; $('mapSelectAll').checked = !!checks.length && count === checks.length; $('mapSelectAll').indeterminate = count > 0 && count < checks.length; $('deleteSelectedMaps').disabled = count === 0; };
  checks.forEach(check => check.addEventListener('change', update));
  $('mapSelectAll').addEventListener('change', () => { checks.forEach(check => check.checked = $('mapSelectAll').checked); update(); });
  $('deleteSelectedMaps').addEventListener('click', () => { const ids = checks.filter(item => item.checked).map(item => item.value); if (!ids.length) return; confirmBulkDelete('Excluir mapas selecionados?', `Serão excluídos ${ids.length} mapa(s) e os pontos vinculados. As imagens permanecem na Biblioteca.`, async () => { const removedPublishedMap = ids.includes(state.campaign.shared.mapId); for (const id of ids) removeMapData(id); await persist(); if (removedPublishedMap) { try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); } } renderMap(); renderPlayerMonitor(); toast('Mapas selecionados excluídos.'); }); });
  $('modalBody').querySelectorAll('[data-map-select]').forEach(button => button.addEventListener('click', () => { state.campaign.editorMapId = button.dataset.mapSelect; state.campaign.editorMapStack = []; persist().then(() => { closeModal(); renderMap(); }); }));
  $('modalBody').querySelectorAll('[data-map-edit]').forEach(button => button.addEventListener('click', () => editMap(button.dataset.mapEdit)));
  $('modalBody').querySelectorAll('[data-map-delete]').forEach(button => button.addEventListener('click', () => deleteMap(button.dataset.mapDelete)));
  $('addMapFromManager').addEventListener('click', showAddMapModal);
}
function removeMapData(mapId) {
  state.campaign.maps = state.campaign.maps.filter(item => item.id !== mapId);
  state.campaign.markers = state.campaign.markers.filter(marker => marker.mapId !== mapId);
  state.campaign.markers.forEach(marker => { if (marker.childMapId === mapId) marker.childMapId = null; });
  state.campaign.editorMapStack = state.campaign.editorMapStack.filter(id => id !== mapId);
  state.campaign.shared.mapStack = state.campaign.shared.mapStack.filter(snapshot => snapshot?.id !== mapId);
  if (state.campaign.editorMapId === mapId) state.campaign.editorMapId = state.campaign.maps[0]?.id || null;
  if (state.campaign.shared.mapId === mapId) { state.campaign.shared.mapId = null; state.campaign.shared.mapStack = []; state.campaign.shared.mapSnapshot = null; }
  if (!state.campaign.markers.some(marker => marker.id === state.campaign.shared.focusedMarkerId)) state.campaign.shared.focusedMarkerId = null;
}
function showAddMapModal() {
  const images = state.assets.filter(asset => asset.kind === 'image');
  const options = images.map(asset => `<option value="${asset.assetId}">${escapeHtml(asset.name)}</option>`).join('');
  modal('Adicionar mapa', `<form id="addMapForm"><div class="form-field"><label for="newMapName">Nome do mapa</label><input id="newMapName" name="name" required maxlength="80" placeholder="Ex.: Takayama"></div><div class="form-field"><label for="newMapAsset">Imagem do mapa</label><select id="newMapAsset" name="assetId" ${images.length ? 'required' : 'disabled'}><option value="">${images.length ? 'Escolha uma imagem' : 'Nenhuma imagem na biblioteca'}</option>${options}</select></div><div class="modal-actions"><button type="button" class="button button-secondary" id="uploadMapFromModal">Enviar nova imagem</button><button type="button" class="button button-quiet" data-modal-cancel>Cancelar</button><button type="submit" class="button button-primary" ${images.length ? '' : 'disabled'}>Criar mapa</button></div></form>`);
  $('uploadMapFromModal').addEventListener('click', () => { closeModal(); $('mapUploadInput').click(); });
  $('addMapForm').addEventListener('submit', async event => { event.preventDefault(); const data = new FormData(event.currentTarget); addMapRecord(data.get('assetId'), data.get('name')); closeModal(); });
}
function editMap(mapId) {
  const map = getMap(mapId); if (!map) return;
  const images = state.assets.filter(asset => asset.kind === 'image');
  const options = images.map(asset => `<option value="${asset.assetId}" ${asset.assetId === map.assetId ? 'selected' : ''}>${escapeHtml(asset.name)}</option>`).join('');
  modal('Editar mapa', `<form id="editMapForm"><div class="form-field"><label for="editMapName">Nome do mapa</label><input id="editMapName" name="name" required maxlength="80" value="${escapeHtml(map.name)}"></div><div class="form-field"><label for="editMapAsset">Imagem do mapa</label><select id="editMapAsset" name="assetId" ${images.length ? '' : 'disabled'}>${options}</select><label class="button button-secondary upload-label inline-upload">＋ Enviar outra imagem<input id="editMapUpload" type="file" accept="image/*" hidden></label><small class="helper">Você pode escolher uma imagem existente ou enviar uma nova. Os pontos continuam vinculados ao mapa.</small></div><div class="modal-actions"><button type="button" class="button button-secondary" data-modal-cancel>Cancelar</button><button type="submit" class="button button-primary">Salvar alterações</button></div></form>`);
  $('editMapUpload').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    const [asset] = await addFilesToCampaign([file], 'image');
    const option = document.createElement('option'); option.value = asset.assetId; option.textContent = asset.name;
    $('editMapAsset').append(option); $('editMapAsset').disabled = false; $('editMapAsset').value = asset.assetId;
    toast('Nova imagem adicionada à biblioteca e selecionada para este mapa.');
  });
  $('editMapForm').addEventListener('submit', async event => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    map.name = String(data.get('name')).trim();
    map.assetId = data.get('assetId') || map.assetId;
    await persist(); closeModal(); renderMap(); showMapManager(); toast('Mapa atualizado.');
  });
}
function deleteMap(mapId) {
  const map = getMap(mapId); if (!map) return;
  const markerCount = mapMarkers(mapId).length;
  modal('Excluir mapa?', `<div class="settings-note"><strong>${escapeHtml(map.name)}</strong><br>O mapa será removido da lista e seus ${markerCount} ponto(s) serão excluídos. A imagem continuará na Biblioteca e poderá ser usada novamente.</div><div class="modal-actions"><button class="button button-secondary" data-modal-cancel>Cancelar</button><button class="button button-primary" id="confirmDeleteMap">Excluir mapa</button></div>`);
  $('confirmDeleteMap').addEventListener('click', async () => {
    const publishedMapWasDeleted = state.campaign.shared.mapId === mapId;
    removeMapData(mapId);
    await persist();
    if (publishedMapWasDeleted) await hidePublishedMapFromPlayers({ silent: true });
    closeModal(); renderMap(); renderPlayerMonitor(); toast('Mapa excluído.');
  });
}
$('manageMapsButton').addEventListener('click', showMapManager);
$('addNewMapButton').addEventListener('click', showAddMapModal);
$('emptyManageMapsButton').addEventListener('click', showMapManager);
$('shareMapButton').addEventListener('click', async () => {
  const map = getEditorMap(); if (!map) return;
  const wasShared = state.campaign.shared.mapId === map.id;
  state.campaign.shared.mapId = map.id; state.campaign.shared.mapStack = []; state.campaign.shared.mapSnapshot = { id: map.id, assetId: map.assetId, name: map.name };
  state.campaign.shared.focusedNpcId = null; state.campaign.shared.npcPresentation = null; state.campaign.shared.focusedMarkerId = null;
  await persist(); renderMap(); renderPlayerMonitor();
  try {
    const published = await publishCurrentMapToPlayers({ silent: true });
    if (published) toast(wasShared ? 'Mapa atualizado e sincronizado com os jogadores.' : 'Mapa apresentado e sincronizado com os jogadores.');
    else toast('Mapa preparado na prévia. Crie uma sessão online para transmitir aos jogadores.');
  } catch (error) { console.error(error); toast(authErrorMessage(error)); }
});
$('hideMapButton').addEventListener('click', async () => {
  state.campaign.shared.mapId = null; state.campaign.shared.mapSnapshot = null; state.campaign.shared.mapStack = []; state.campaign.shared.focusedMarkerId = null;
  await persist(); await hidePublishedMapFromPlayers({ silent: true }); renderMap(); renderPlayerMonitor(); toast('Mapa ocultado dos jogadores.');
});
function setMarkerMode(enabled) {
  state.markerMode = enabled; $('addMapMarkerButton').textContent = enabled ? 'Clique no mapa para posicionar' : '＋ Adicionar ponto';
  $('addMapMarkerButton').classList.toggle('button-primary', !enabled); $('addMapMarkerButton').classList.toggle('button-secondary', enabled);
  if (enabled && !getEditorMap()) { toast('Crie ou selecione um mapa antes de adicionar pontos.'); state.markerMode = false; $('addMapMarkerButton').textContent = '＋ Adicionar ponto'; return; }
  if (enabled) toast('Clique na posição desejada do mapa.');
}
$('addMapMarkerButton').addEventListener('click', () => setMarkerMode(!state.markerMode));
$('mapBackButton').addEventListener('click', async () => { const previous = state.campaign.editorMapStack.pop(); if (!previous) return; state.campaign.editorMapId = previous; await persist(); renderMap(); });
function onMapStageClick(event) {
  if (!state.markerMode || event.target.closest('[data-marker-id]')) return;
  const stage = $('mapStage'); const rect = stage.getBoundingClientRect();
  const x = Math.min(99, Math.max(1, ((event.clientX - rect.left) / rect.width) * 100));
  const y = Math.min(99, Math.max(1, ((event.clientY - rect.top) / rect.height) * 100));
  setMarkerMode(false); showAddMarkerModal(x, y, state.pendingNpcId || null); state.pendingNpcId = null;
}
function showAddMarkerModal(x, y, presetNpcId = null) {
  const npcOptions = state.campaign.npcs.map(npc => `<option value="${npc.id}" ${npc.id === presetNpcId ? 'selected' : ''}>${escapeHtml(npc.name)}</option>`).join('');
  const mapOptions = state.campaign.maps.filter(map => map.id !== state.campaign.editorMapId).map(map => `<option value="${map.id}">${escapeHtml(map.name)}</option>`).join('');
  modal('Adicionar ponto ao mapa', `<form id="markerForm"><div class="form-field"><label for="markerType">Tipo de ponto</label><select id="markerType" name="type"><option value="location" ${presetNpcId ? '' : 'selected'}>Localidade</option><option value="npc" ${presetNpcId ? 'selected' : ''} ${state.campaign.npcs.length ? '' : 'disabled'}>NPC existente</option></select></div>
    <div id="markerLocationFields"><div class="form-field"><label for="markerName">Nome da localidade</label><input id="markerName" name="name" maxlength="60" placeholder="Ex.: Academia Seiryō"></div><div class="form-field"><label for="markerDescription">Descrição pública</label><textarea id="markerDescription" name="description" placeholder="Informações que poderão ser apresentadas"></textarea></div><div class="form-field"><label for="markerIcon">Ícone do ponto</label><select id="markerIcon" name="icon"><option value="⌖">Marcador</option><option value="♥">Coração</option><option value="★">Estrela</option><option value="⚑">Bandeira</option><option value="🏠">Casa</option><option value="⛩">Templo</option><option value="☕">Estabelecimento</option><option value="⚔">Combate</option><option value="✦">Especial</option></select><input name="customIcon" maxlength="4" placeholder="Ou escolha seu próprio símbolo (opcional)" aria-label="Símbolo personalizado" class="custom-marker-icon-input"></div><div class="form-field"><label for="markerChildMap">Mapa interno (opcional)</label><select id="markerChildMap" name="childMapId"><option value="">Nenhum</option>${mapOptions}</select></div></div>
    <div id="markerNpcFields" class="hidden"><div class="form-field"><label for="markerNpcId">NPC</label><select id="markerNpcId" name="npcId">${npcOptions}</select></div><div class="form-field"><label for="markerNpcIcon">Ícone do NPC no mapa</label><select id="markerNpcIcon" name="iconMode"><option value="portrait">Usar retrato do NPC</option><option value="pin">Usar marcador padrão</option></select></div></div>
    <div class="form-check-row"><label><input type="checkbox" name="visibleToPlayers"> Apresentar este ponto aos jogadores agora</label></div><div class="form-check-row"><label><input type="checkbox" name="playerClickable"> Permitir que os jogadores cliquem neste ponto</label></div>
    <div class="modal-actions"><button type="button" class="button button-secondary" data-modal-cancel>Cancelar</button><button type="submit" class="button button-primary">Adicionar ponto</button></div></form>`);
  const updateType = () => { const npc = $('markerType').value === 'npc'; $('markerLocationFields').classList.toggle('hidden', npc); $('markerNpcFields').classList.toggle('hidden', !npc); };
  $('markerType').addEventListener('change', updateType); updateType();
  $('markerForm').addEventListener('submit', async event => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const type = data.get('type'); let marker;
    if (type === 'npc') {
      const npc = state.campaign.npcs.find(item => item.id === data.get('npcId')); if (!npc) return;
      marker = { id: uid('marker'), type: 'npc', npcId: npc.id, name: npc.name, description: '', mapId: state.campaign.editorMapId, x, y, iconMode: data.get('iconMode') || 'portrait', visibleToPlayers: data.has('visibleToPlayers'), playerClickable: data.has('playerClickable') };
    } else {
      const name = String(data.get('name') || '').trim(); if (!name) { $('markerName').focus(); return; }
      marker = { id: uid('marker'), type: 'location', name, description: String(data.get('description') || ''), icon: String(data.get('customIcon') || '').trim() || data.get('icon') || '⌖', mapId: state.campaign.editorMapId, childMapId: data.get('childMapId') || null, x, y, visibleToPlayers: data.has('visibleToPlayers'), playerClickable: data.has('playerClickable') };
    }
    if (marker.playerClickable) marker.visibleToPlayers = true;
    state.campaign.markers.push(marker); if (marker.visibleToPlayers) marker.publishedSnapshot = makeMarkerSnapshot(marker); await persist(); if (marker.visibleToPlayers) await publishMarkerChangeIfMapIsLive(marker.mapId); closeModal(); renderMap(); toast('Ponto adicionado.');
  });
}
function makeNpcPresentationSnapshot(npc) {
  if (!npc) return null;
  return { npcId: npc.id, name: npc.name, role: npc.role || '', portraitAssetId: npcPortraitAssetId(npc), publicDescription: npc.publicDescription || '', publicRelations: npc.publicRelations || '' };
}
function makeMarkerSnapshot(marker) {
  const npc = marker.type === 'npc' ? state.campaign.npcs.find(item => item.id === marker.npcId) : null;
  return { id: marker.id, type: marker.type, name: marker.name, description: marker.description || '', icon: marker.icon || '⌖', iconMode: marker.iconMode || 'pin', npcId: marker.npcId || null, childMapId: marker.childMapId || null, x: marker.x, y: marker.y, portraitAssetId: npcPortraitAssetId(npc), publicDescription: npc?.publicDescription || '', publicRelations: npc?.publicRelations || '', playerClickable: !!marker.playerClickable };
}

function showMarkerDetails(markerId) {
  const marker = state.campaign.markers.find(item => item.id === markerId); if (!marker) return;
  const npc = marker.type === 'npc' ? state.campaign.npcs.find(item => item.id === marker.npcId) : null;
  const childMapOptions = state.campaign.maps.filter(map => map.id !== marker.mapId).map(map => `<option value="${map.id}" ${marker.childMapId === map.id ? 'selected' : ''}>${escapeHtml(map.name)}</option>`).join('');
  const description = npc?.publicDescription || marker.description || '';
  const privateInfo = npc?.privateNotes ? `<div class="settings-note"><strong>Anotações privadas:</strong><br>${escapeHtml(npc.privateNotes)}</div>` : '';
  const portraitId = npcPortraitAssetId(npc); const portrait = portraitId ? state.assets.find(asset => asset.assetId === portraitId) : null;
  const portraitHtml = portrait ? `<img class="detail-npc-portrait" src="${getAssetUrl(portrait)}" alt="">` : '';
  modal(`Ponto: ${marker.name}`, `<div class="marker-detail-preview">${portraitHtml}<div><strong>${escapeHtml(marker.name)}</strong><p>${escapeHtml(description || 'Sem descrição pública.')}</p></div></div>${npc ? `<div class="settings-note"><strong>Relações conhecidas:</strong><br>${escapeHtml(npc.publicRelations || 'Não informadas.')}</div>${privateInfo}` : ''}<form id="markerEditForm"><div class="form-field"><label for="markerEditName">Nome</label><input id="markerEditName" name="name" value="${escapeHtml(marker.name)}" required></div>${marker.type === 'location' ? `<div class="form-field"><label for="markerEditDescription">Descrição pública</label><textarea id="markerEditDescription" name="description">${escapeHtml(marker.description || '')}</textarea></div><div class="form-field"><label for="markerEditIcon">Ícone do ponto</label><select id="markerEditIcon" name="icon"><option value="⌖" ${marker.icon === '⌖' ? 'selected' : ''}>⌖ Marcador</option><option value="♥" ${marker.icon === '♥' ? 'selected' : ''}>♥ Coração</option><option value="★" ${marker.icon === '★' ? 'selected' : ''}>★ Estrela</option><option value="⚑" ${marker.icon === '⚑' ? 'selected' : ''}>⚑ Bandeira</option><option value="🏠" ${marker.icon === '🏠' ? 'selected' : ''}>🏠 Casa</option><option value="⛩" ${marker.icon === '⛩' ? 'selected' : ''}>⛩ Templo</option><option value="☕" ${marker.icon === '☕' ? 'selected' : ''}>☕ Estabelecimento</option><option value="⚔" ${marker.icon === '⚔' ? 'selected' : ''}>⚔ Combate</option><option value="✦" ${marker.icon === '✦' ? 'selected' : ''}>✦ Especial</option></select><input name="customIcon" maxlength="4" placeholder="Símbolo personalizado (opcional)" value="${['⌖','♥','★','⚑','🏠','⛩','☕','⚔','✦'].includes(marker.icon) ? '' : escapeHtml(marker.icon || '')}" class="custom-marker-icon-input"></div><div class="form-field"><label for="markerEditChild">Mapa interno</label><select id="markerEditChild" name="childMapId"><option value="">Nenhum</option>${childMapOptions}</select></div>` : `<div class="form-field"><label for="markerEditIconMode">Ícone do NPC</label><select id="markerEditIconMode" name="iconMode"><option value="portrait" ${marker.iconMode !== 'pin' ? 'selected' : ''}>Retrato do NPC</option><option value="pin" ${marker.iconMode === 'pin' ? 'selected' : ''}>Marcador padrão</option></select></div>`}
    <div class="form-check-row"><label><input type="checkbox" name="visibleToPlayers" ${marker.visibleToPlayers ? 'checked' : ''}> Apresentar este ponto aos jogadores</label></div><div class="form-check-row"><label><input type="checkbox" name="playerClickable" ${marker.playerClickable ? 'checked' : ''}> Permitir cliques dos jogadores</label></div><div class="modal-actions"><button type="button" class="button button-secondary" id="removeMarkerButton">Remover ponto</button><button type="button" class="button button-quiet" data-modal-cancel>Fechar</button><button type="submit" class="button button-primary">Salvar</button></div></form>`);
  $('markerEditForm').addEventListener('submit', async event => {
    event.preventDefault(); const wasPublished = !!marker.publishedSnapshot; const data = new FormData(event.currentTarget); marker.name = String(data.get('name')).trim(); marker.visibleToPlayers = data.has('visibleToPlayers'); marker.playerClickable = data.has('playerClickable'); if (marker.playerClickable) marker.visibleToPlayers = true;
    if (marker.type === 'location') { marker.description = String(data.get('description') || ''); marker.icon = String(data.get('customIcon') || '').trim() || data.get('icon') || '⌖'; marker.childMapId = data.get('childMapId') || null; }
    else { marker.iconMode = data.get('iconMode') || 'portrait'; if (npc) marker.name = npc.name; }
    if (!marker.visibleToPlayers) marker.publishedSnapshot = null;
    else marker.publishedSnapshot = makeMarkerSnapshot(marker);
    await persist(); await publishMarkerChangeIfMapIsLive(marker.mapId); closeModal(); renderMap(); toast('Ponto atualizado.');
  });
  $('removeMarkerButton').addEventListener('click', async () => { state.campaign.markers = state.campaign.markers.filter(item => item.id !== marker.id); if (state.campaign.shared.focusedMarkerId === marker.id) state.campaign.shared.focusedMarkerId = null; await persist(); await publishMarkerChangeIfMapIsLive(marker.mapId); closeModal(); renderMap(); renderPlayerMonitor(); toast('Ponto removido.'); });
  if (marker.type === 'location' && marker.childMapId) {
    const openButton = document.createElement('button'); openButton.type = 'button'; openButton.className = 'button button-secondary'; openButton.textContent = 'Abrir mapa interno';
    $('markerEditForm').querySelector('.modal-actions').prepend(openButton);
    openButton.addEventListener('click', async () => { const child = getMap(marker.childMapId); if (!child) return; state.campaign.editorMapStack.push(state.campaign.editorMapId); state.campaign.editorMapId = child.id; await persist(); closeModal(); renderMap(); });
  }
}
async function publishMarkerChangeIfMapIsLive(mapId) {
  if (state.campaign?.shared?.mapId !== mapId) return false;
  try {
    const published = await publishCurrentMapToPlayers({ silent: true });
    if (published) renderPlayerMonitor();
    return published;
  } catch (error) {
    console.error('Falha ao atualizar marcador na apresentação:', error);
    toast(authErrorMessage(error));
    return false;
  }
}
async function toggleMarkerPublished(markerId) {
  const marker = state.campaign.markers.find(item => item.id === markerId); if (!marker) return;
  marker.visibleToPlayers = !marker.visibleToPlayers;
  if (!marker.visibleToPlayers) { marker.playerClickable = false; marker.publishedSnapshot = null; }
  else marker.publishedSnapshot = makeMarkerSnapshot(marker);
  await persist();
  await publishMarkerChangeIfMapIsLive(marker.mapId);
  renderMap();
}
async function refreshMarkerPresentation(markerId) {
  const marker = state.campaign.markers.find(item => item.id === markerId); if (!marker) return;
  marker.publishedSnapshot = makeMarkerSnapshot(marker); marker.visibleToPlayers = true;
  await persist();
  await publishMarkerChangeIfMapIsLive(marker.mapId);
  renderMap(); toast('Informações atualizadas na tela dos jogadores.');
}
async function toggleMarkerClickable(markerId) {
  const marker = state.campaign.markers.find(item => item.id === markerId); if (!marker) return;
  marker.playerClickable = !marker.playerClickable;
  if (marker.playerClickable && (!marker.visibleToPlayers || !marker.publishedSnapshot)) { marker.visibleToPlayers = true; marker.publishedSnapshot = makeMarkerSnapshot(marker); }
  if (marker.publishedSnapshot) marker.publishedSnapshot.playerClickable = marker.playerClickable;
  await persist();
  await publishMarkerChangeIfMapIsLive(marker.mapId);
  renderMap(); toast(marker.playerClickable ? 'Jogadores podem clicar neste ponto.' : 'Clique dos jogadores bloqueado.');
}
// Os controles de voltar e gerenciar mapas são registrados uma única vez na inicialização.

// Gerenciador em lote compartilhado pelas bibliotecas e áreas da campanha.
function showBulkManager(title, items, actions, emptyText = 'Nada para gerenciar nesta área.') {
  const rows = items.length ? items.map(item => `<label class="bulk-manager-row"><input type="checkbox" class="bulk-manager-check" value="${escapeHtml(item.key)}"><span class="bulk-manager-symbol">${escapeHtml(item.icon || '▧')}</span><span class="bulk-manager-copy"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.meta || '')}</small></span></label>`).join('') : `<div class="empty-library-note">${escapeHtml(emptyText)}</div>`;
  const buttons = actions.map((action,index) => `<button type="button" class="button ${action.variant || 'button-secondary'}" data-bulk-action="${index}" ${items.length ? '' : 'disabled'}>${escapeHtml(action.label)}</button>`).join('');
  modal(title, `<div class="bulk-manager-toolbar"><label><input type="checkbox" id="bulkSelectAll"> Selecionar tudo</label><span id="bulkSelectedCount">0 selecionado(s)</span></div><div class="bulk-manager-list">${rows}</div><div class="modal-actions bulk-manager-actions"><button type="button" class="button button-quiet" data-modal-cancel>Fechar</button>${buttons}</div>`);
  const checks = [...$('modalBody').querySelectorAll('.bulk-manager-check')];
  const selectAll = $('bulkSelectAll');
  const update = () => { const count = checks.filter(check => check.checked).length; $('bulkSelectedCount').textContent = `${count} selecionado(s)`; selectAll.checked = checks.length > 0 && count === checks.length; selectAll.indeterminate = count > 0 && count < checks.length; $('modalBody').querySelectorAll('[data-bulk-action]').forEach(button => { button.disabled = count === 0; }); };
  checks.forEach(check => check.addEventListener('change', update));
  selectAll.addEventListener('change', () => { checks.forEach(check => { check.checked = selectAll.checked; }); update(); });
  $('modalBody').querySelectorAll('[data-bulk-action]').forEach(button => button.addEventListener('click', async () => {
    const selected = checks.filter(check => check.checked).map(check => check.value);
    if (!selected.length) return;
    await actions[Number(button.dataset.bulkAction)].run(selected);
  }));
}
function confirmBulkDelete(title, description, onConfirm) {
  modal(title, `<p class="settings-note">${escapeHtml(description)}</p><div class="modal-actions"><button type="button" class="button button-secondary" data-modal-cancel>Cancelar</button><button type="button" class="button button-primary" id="confirmBulkDeleteButton">Excluir selecionados</button></div>`);
  $('confirmBulkDeleteButton').addEventListener('click', async () => { closeModal(); await onConfirm(); });
}

// NPCs: retratos em armazenamento e biblioteca exclusivos, com enquadramento ajustável.
function renderNpcs() {
  const npcs = state.campaign.npcs;
  $('npcGrid').innerHTML = npcs.length ? npcs.map(npc => {
    const portrait = state.assets.find(asset => asset.assetId === npcPortraitAssetId(npc));
    const image = portrait ? `<img src="${getAssetUrl(portrait)}" alt="">` : '<span>♙</span>';
    const markers = state.campaign.markers.filter(marker => marker.npcId === npc.id);
    const isPresented = state.campaign.shared.focusedNpcId === npc.id;
    return `<article class="npc-card"><div class="npc-avatar">${image}</div><div class="npc-card-main"><strong>${escapeHtml(npc.name)}</strong><small>${escapeHtml(npc.role || 'NPC')}</small><p>${escapeHtml(npc.publicDescription || 'Sem descrição pública.')}</p><div class="npc-card-actions"><button type="button" class="mini-button" data-edit-npc="${npc.id}">Editar</button><button type="button" class="mini-button" data-place-npc="${npc.id}">Colocar no mapa</button><button type="button" class="mini-button ${isPresented ? 'active' : ''}" data-toggle-npc-presentation="${npc.id}">${isPresented ? 'Ocultar dos jogadores' : 'Apresentar aos jogadores'}</button></div><small class="npc-map-count">${markers.length} ponto(s) em mapas</small></div></article>`;
  }).join('') : emptyState('♙', 'Nenhum NPC cadastrado', 'Adicione personagens e seus retratos nesta área exclusiva.');
  $('npcGrid').querySelectorAll('[data-edit-npc]').forEach(button => button.addEventListener('click', () => editNpc(button.dataset.editNpc)));
  $('npcGrid').querySelectorAll('[data-place-npc]').forEach(button => button.addEventListener('click', () => chooseMapForNpc(button.dataset.placeNpc)));
  $('npcGrid').querySelectorAll('[data-toggle-npc-presentation]').forEach(button => button.addEventListener('click', async () => {
    const npcId = button.dataset.toggleNpcPresentation;
    if (state.campaign.shared.focusedNpcId === npcId || state.campaign.shared.npcPresentation?.npcId === npcId) { state.campaign.shared.focusedNpcId = null; state.campaign.shared.npcPresentation = null; }
    else { const npc = state.campaign.npcs.find(item => item.id === npcId); state.campaign.shared.focusedNpcId = npcId; state.campaign.shared.npcPresentation = makeNpcPresentationSnapshot(npc); }
    await persist();
    try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); }
    renderNpcs(); renderPlayerMonitor(); toast(state.campaign.shared.focusedNpcId ? 'NPC apresentado aos jogadores.' : 'NPC ocultado dos jogadores.');
  }));
}
function showNpcManager() {
  const items = state.campaign.npcs.map(npc => ({ key: npc.id, name: npc.name || 'NPC sem nome', meta: `NPC · ${npc.role || 'Sem função'}`, icon: '♙' }));
  showBulkManager('Gerenciar NPCs', items, [{ label: 'Excluir NPCs selecionados', variant: 'button-primary', run: async selected => {
    confirmBulkDelete('Excluir NPCs selecionados?', `Serão excluídos ${selected.length} personagem(ns) e seus pontos vinculados.`, async () => {
      for (const npcId of selected) {
        const npc = state.campaign.npcs.find(item => item.id === npcId);
        state.campaign.npcs = state.campaign.npcs.filter(item => item.id !== npcId);
        state.campaign.markers = state.campaign.markers.filter(marker => marker.npcId !== npcId);
        if (state.campaign.shared.focusedNpcId === npcId || state.campaign.shared.npcPresentation?.npcId === npcId) { state.campaign.shared.focusedNpcId = null; state.campaign.shared.npcPresentation = null; }
        // Remove o retrato interno apenas quando nenhum outro NPC o utiliza.
        const portraitId = npc?.portraitAssetId, cropId = npc?.portraitCropAssetId;
        if (cropId) {
          await deleteAsset(state.campaign.id, cropId); state.assets = state.assets.filter(asset => asset.assetId !== cropId);
          const cropUrl = state.objectUrls.get(cropId); if (cropUrl) URL.revokeObjectURL(cropUrl); state.objectUrls.delete(cropId);
        }
        if (portraitId && !state.campaign.npcs.some(item => item.portraitAssetId === portraitId)) {
          await deleteAsset(state.campaign.id, portraitId); state.assets = state.assets.filter(asset => asset.assetId !== portraitId);
          const url = state.objectUrls.get(portraitId); if (url) URL.revokeObjectURL(url); state.objectUrls.delete(portraitId);
        }
      }
      await persist();
      try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); }
      renderNpcs(); renderMap(); renderPlayerMonitor(); toast('NPCs selecionados excluídos.');
    });
  }}], 'Nenhum NPC cadastrado para gerenciar.');
}
$('manageNpcsButton').addEventListener('click', showNpcManager);

async function deleteNpcPortrait(assetId) {
  const used = state.campaign.npcs.some(npc => npc.portraitAssetId === assetId || npc.portraitCropAssetId === assetId);
  modal('Excluir retrato?', `<div class="settings-note">${used ? 'Este retrato está associado a um ou mais NPCs. Ao excluir, eles ficarão sem retrato.' : 'Este retrato será removido da biblioteca de NPCs.'}</div><div class="modal-actions"><button class="button button-secondary" data-modal-cancel>Cancelar</button><button class="button button-primary" id="confirmDeleteNpcPortrait">Excluir</button></div>`);
  $('confirmDeleteNpcPortrait').addEventListener('click', async () => {
    const cropIds = new Set();
    state.campaign.npcs.forEach(npc => {
      if (npc.portraitAssetId === assetId || npc.portraitCropAssetId === assetId) {
        if (npc.portraitCropAssetId) cropIds.add(npc.portraitCropAssetId);
        npc.portraitAssetId = null; npc.portraitCropAssetId = null;
      }
    });
    for (const id of new Set([assetId, ...cropIds])) {
      await deleteAsset(state.campaign.id, id); state.assets = state.assets.filter(asset => asset.assetId !== id);
      const url = state.objectUrls.get(id); if (url) URL.revokeObjectURL(url); state.objectUrls.delete(id);
    }
    state.campaign.markers.forEach(marker => { if (marker.type === 'npc' && marker.visibleToPlayers) marker.publishedSnapshot = makeMarkerSnapshot(marker); });
    if (state.campaign.shared.npcPresentation?.npcId) { const npc = state.campaign.npcs.find(item => item.id === state.campaign.shared.npcPresentation.npcId); state.campaign.shared.npcPresentation = npc ? makeNpcPresentationSnapshot(npc) : null; }
    await persist();
    try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); }
    closeModal(); renderNpcs(); renderMap(); renderPlayerMonitor();
  });
}

function chooseMapForNpc(npcId) {
  const npc = state.campaign.npcs.find(item => item.id === npcId); if (!npc) return;
  const maps = state.campaign.maps;
  const rows = maps.length ? maps.map(map => `<button class="campaign-row" data-target-map="${map.id}"><div><strong>${escapeHtml(map.name)}</strong><small>${mapMarkers(map.id).length} ponto(s)</small></div><span>›</span></button>`).join('') : emptyState('⌖','Nenhum mapa disponível','Crie um mapa antes de posicionar este NPC.');
  modal(`Colocar ${npc.name} no mapa`, `<p class="helper-copy">Primeiro escolha em qual mapa o NPC aparecerá. Depois, clique no local desejado.</p><div class="campaign-list">${rows}</div><div class="modal-actions"><button class="button button-secondary" data-modal-cancel>Cancelar</button></div>`);
  $('modalBody').querySelectorAll('[data-target-map]').forEach(button => button.addEventListener('click', async () => { state.campaign.editorMapId = button.dataset.targetMap; state.pendingNpcId = npcId; await persist(); closeModal(); switchView('map'); setMarkerMode(true); }));
}
$('addNpcButton').addEventListener('click', () => editNpc(null));
function editNpc(npcId) {
  const npc = state.campaign.npcs.find(item => item.id === npcId) || { id: uid('npc'), name: '', role: '', publicDescription: '', publicRelations: '', privateNotes: '', portraitAssetId: null, portraitCropAssetId: null, portraitZoom: 1.35, portraitX: 50, portraitY: 50 };
  const portraits = state.assets.filter(asset => asset.kind === 'npcPortrait').map(asset => `<option value="${asset.assetId}" ${npc.portraitAssetId === asset.assetId ? 'selected' : ''}>${escapeHtml(asset.name)}</option>`).join('');
  modal(npcId ? 'Editar NPC' : 'Novo NPC', `<form id="npcForm"><div class="form-grid">
    <div class="form-field"><label for="npcName">Nome</label><input id="npcName" name="name" maxlength="70" required value="${escapeHtml(npc.name)}" placeholder="Nome do personagem"></div>
    <div class="form-field"><label for="npcRole">Função ou ocupação</label><input id="npcRole" name="role" maxlength="70" value="${escapeHtml(npc.role)}" placeholder="Ex.: Professora"></div>
    <div class="form-field full"><label for="npcPortrait">Retrato da biblioteca de NPCs</label><select id="npcPortrait" name="portraitAssetId"><option value="">Sem retrato</option>${portraits}</select><label class="button button-secondary upload-label inline-upload">＋ Enviar novo retrato<input id="npcPortraitUpload" type="file" accept="image/*" hidden></label><small class="helper">O original fica preservado. A imagem recortada é gerada separadamente e usada em todos os lugares.</small></div>
    <div class="form-field full"><label>Área de corte do retrato</label><div class="npc-crop-layout"><div id="npcPortraitCropper" class="npc-cropper" aria-label="Arraste a imagem para ajustar o enquadramento"><canvas class="npc-crop-canvas" width="800" height="1000"></canvas><span class="npc-crop-empty">♙</span></div><div class="npc-crop-controls"><label for="npcPortraitZoom">Zoom <strong id="npcPortraitZoomValue">${Math.round((npc.portraitZoom || 1.35) * 100)}%</strong></label><input id="npcPortraitZoom" name="portraitZoom" type="range" min="1" max="3.5" step="0.05" value="${npc.portraitZoom || 1.35}"><small>Arraste a imagem com o mouse ou o dedo. O recorte mostrado aqui será exatamente o usado no cartão, no mapa e na tela dos jogadores.</small><button type="button" class="button button-secondary button-small" id="resetNpcCrop">Centralizar imagem</button></div></div><input id="npcPortraitX" name="portraitX" type="hidden" value="${npc.portraitX ?? 50}"><input id="npcPortraitY" name="portraitY" type="hidden" value="${npc.portraitY ?? 50}"></div>
    <div class="form-field full"><label for="npcPublicDescription">Descrição visível aos jogadores</label><textarea id="npcPublicDescription" name="publicDescription" placeholder="Quem é essa pessoa?">${escapeHtml(npc.publicDescription)}</textarea></div>
    <div class="form-field full"><label for="npcPublicRelations">Relações conhecidas pelos jogadores</label><textarea id="npcPublicRelations" name="publicRelations" placeholder="Ex.: Amigo de Y, rival de Z">${escapeHtml(npc.publicRelations)}</textarea></div>
    <div class="form-field full"><label for="npcPrivateNotes">Anotações privadas do mestre</label><textarea id="npcPrivateNotes" name="privateNotes" placeholder="Segredos, intenções e informações ocultas">${escapeHtml(npc.privateNotes)}</textarea><small class="helper">Este campo nunca é apresentado aos jogadores.</small></div></div>
    <div class="modal-actions">${npcId ? '<button type="button" class="button button-quiet" id="deleteNpcButton">Excluir NPC</button>' : ''}<button type="button" class="button button-secondary" data-modal-cancel>Cancelar</button><button type="submit" class="button button-primary">Salvar NPC</button></div></form>`);

  let cropX = Number(npc.portraitX ?? 50), cropY = Number(npc.portraitY ?? 50), cropZoom = Number(npc.portraitZoom || 1.35), dragging = false, lastPoint = null;
  let selectedBitmap = null, loadedAssetId = null, loadSequence = 0;
  const cropper = $('npcPortraitCropper'), canvas = cropper.querySelector('canvas');
  function updateCrop() {
    const asset = state.assets.find(item => item.assetId === $('npcPortrait').value);
    canvas.classList.toggle('hidden', !selectedBitmap);
    cropper.querySelector('.npc-crop-empty').classList.toggle('hidden', !!selectedBitmap);
    if (selectedBitmap) drawPortraitCrop(canvas, selectedBitmap, cropX, cropY, cropZoom);
    $('npcPortraitX').value = cropX; $('npcPortraitY').value = cropY; $('npcPortraitZoom').value = cropZoom;
    $('npcPortraitZoomValue').textContent = `${Math.round(cropZoom * 100)}%`;
    cropper.classList.toggle('has-image', !!asset && !!selectedBitmap);
  }
  async function loadSelectedPortrait() {
    const assetId = $('npcPortrait').value;
    if (assetId === loadedAssetId) { updateCrop(); return; }
    const sequence = ++loadSequence; loadedAssetId = assetId;
    selectedBitmap?.close?.(); selectedBitmap = null;
    if (!assetId) { updateCrop(); return; }
    const asset = state.assets.find(item => item.assetId === assetId);
    try { const bitmap = await decodeAssetImage(asset); if (sequence !== loadSequence) { bitmap.close?.(); return; } selectedBitmap = bitmap; updateCrop(); }
    catch (error) { console.error(error); toast('Não foi possível abrir este retrato.'); updateCrop(); }
  }
  cropper.addEventListener('pointerdown', event => { if (!selectedBitmap) return; dragging = true; lastPoint = { x: event.clientX, y: event.clientY }; cropper.classList.add('dragging'); cropper.setPointerCapture(event.pointerId); event.preventDefault(); });
  cropper.addEventListener('pointermove', event => {
    if (!dragging || !lastPoint || !selectedBitmap) return;
    const rect = canvas.getBoundingClientRect();
    const bounds = getPortraitCropRect(selectedBitmap.width || selectedBitmap.naturalWidth, selectedBitmap.height || selectedBitmap.naturalHeight, cropX, cropY, cropZoom);
    const dx = event.clientX - lastPoint.x, dy = event.clientY - lastPoint.y;
    if (bounds.maxLeft > 0) cropX = clampPercent(cropX - (dx * bounds.sw / Math.max(1, rect.width)) / bounds.maxLeft * 100);
    if (bounds.maxTop > 0) cropY = clampPercent(cropY - (dy * bounds.sh / Math.max(1, rect.height)) / bounds.maxTop * 100);
    lastPoint = { x: event.clientX, y: event.clientY }; updateCrop();
  });
  const finishCropDrag = () => { dragging = false; lastPoint = null; cropper.classList.remove('dragging'); };
  cropper.addEventListener('pointerup', finishCropDrag); cropper.addEventListener('pointercancel', finishCropDrag); cropper.addEventListener('lostpointercapture', finishCropDrag);
  $('npcPortrait').addEventListener('change', async () => { cropX = 50; cropY = 50; cropZoom = 1.35; await loadSelectedPortrait(); });
  $('npcPortraitZoom').addEventListener('input', () => { cropZoom = Number($('npcPortraitZoom').value); updateCrop(); });
  $('resetNpcCrop').addEventListener('click', () => { cropX = 50; cropY = 50; cropZoom = 1.35; updateCrop(); });
  $('npcPortraitUpload').addEventListener('change', async event => { const file = event.target.files?.[0]; if (!file) return; const [asset] = await addFilesToCampaign([file], 'npcPortrait'); const option = document.createElement('option'); option.value = asset.assetId; option.textContent = asset.name; $('npcPortrait').append(option); $('npcPortrait').value = asset.assetId; cropX = 50; cropY = 50; cropZoom = 1.35; await loadSelectedPortrait(); event.target.value = ''; });
  loadSelectedPortrait();
  $('npcForm').addEventListener('submit', async event => {
    event.preventDefault(); const data = new FormData(event.currentTarget), newName = String(data.get('name')).trim();
    const sourceAssetId = data.get('portraitAssetId') || null, sourceAsset = sourceAssetId ? state.assets.find(asset => asset.assetId === sourceAssetId) : null;
    const oldCropId = npc.portraitCropAssetId || `npc_crop_${npc.id}`;
    Object.assign(npc, { name: newName, role: String(data.get('role') || ''), portraitAssetId: sourceAssetId, portraitZoom: cropZoom, portraitX: cropX, portraitY: cropY, publicDescription: String(data.get('publicDescription') || ''), publicRelations: String(data.get('publicRelations') || ''), privateNotes: String(data.get('privateNotes') || '') });
    if (sourceAsset) npc.portraitCropAssetId = await saveNpcPortraitCrop(npc, sourceAsset, cropX, cropY, cropZoom);
    else { npc.portraitCropAssetId = null; if (state.assets.some(asset => asset.assetId === oldCropId)) { await deleteAsset(state.campaign.id, oldCropId); state.assets = state.assets.filter(asset => asset.assetId !== oldCropId); const oldUrl = state.objectUrls.get(oldCropId); if (oldUrl) URL.revokeObjectURL(oldUrl); state.objectUrls.delete(oldCropId); } }
    const index = state.campaign.npcs.findIndex(item => item.id === npc.id); if (index >= 0) state.campaign.npcs[index] = npc; else state.campaign.npcs.push(npc);
    state.campaign.markers.forEach(marker => { if (marker.npcId !== npc.id) return; marker.name = npc.name; if (marker.visibleToPlayers) marker.publishedSnapshot = makeMarkerSnapshot(marker); });
    if (state.campaign.shared.focusedNpcId === npc.id || state.campaign.shared.npcPresentation?.npcId === npc.id) state.campaign.shared.npcPresentation = makeNpcPresentationSnapshot(npc);
    await persist();
    try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); }
    selectedBitmap?.close?.(); closeModal(); renderNpcs(); renderMap(); renderPlayerMonitor(); toast('NPC salvo. O mesmo arquivo recortado agora é usado em todas as visualizações.');
  });
  $('deleteNpcButton')?.addEventListener('click', async () => {
    const sourceId = npc.portraitAssetId, cropId = npc.portraitCropAssetId;
    state.campaign.npcs = state.campaign.npcs.filter(item => item.id !== npc.id); state.campaign.markers = state.campaign.markers.filter(item => item.npcId !== npc.id);
    if (state.campaign.shared.focusedNpcId === npc.id || state.campaign.shared.npcPresentation?.npcId === npc.id) { state.campaign.shared.focusedNpcId = null; state.campaign.shared.npcPresentation = null; }
    if (cropId) { await deleteAsset(state.campaign.id, cropId); state.assets = state.assets.filter(asset => asset.assetId !== cropId); const url = state.objectUrls.get(cropId); if (url) URL.revokeObjectURL(url); state.objectUrls.delete(cropId); }
    if (sourceId && !state.campaign.npcs.some(item => item.portraitAssetId === sourceId)) { await deleteAsset(state.campaign.id, sourceId); state.assets = state.assets.filter(asset => asset.assetId !== sourceId); const url = state.objectUrls.get(sourceId); if (url) URL.revokeObjectURL(url); state.objectUrls.delete(sourceId); }
    await persist();
    try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); }
    selectedBitmap?.close?.(); closeModal(); renderNpcs(); renderMap(); renderPlayerMonitor(); toast('NPC excluído.');
  });
}

// BIBLIOTECA GERAL: apenas imagens e documentos; áudios e retratos NPC ficam separados.
function renderLibrary() {
  const allowed = state.assets.filter(asset => ['image','document'].includes(asset.kind));
  const assets = allowed.filter(asset => state.libraryFilter === 'all' || asset.kind === state.libraryFilter);
  $('librarySummary').textContent = `${assets.length} arquivo(s)`;
  $('libraryGrid').innerHTML = assets.length ? assets.map(asset => {
    const preview = asset.kind === 'image' ? `<img src="${getAssetUrl(asset)}" alt="">` : '<span class="document-preview">▤</span>';
    const published = state.campaign.shared.presentation?.assetId === asset.assetId;
    return `<article class="asset-card"><div class="asset-preview">${preview}<span class="asset-type-label">${asset.kind === 'image' ? (asset.mime === 'image/gif' ? 'GIF' : 'IMAGEM') : 'DOCUMENTO'}</span></div><div class="asset-details"><strong title="${escapeHtml(asset.name)}">${escapeHtml(asset.name)}</strong><small>${formatBytes(asset.size)}</small><div class="asset-actions"><button type="button" class="mini-button ${published ? 'active' : ''}" data-present-asset="${asset.assetId}">${published ? 'Ocultar' : 'Apresentar'}</button><button type="button" class="mini-button danger" data-delete-library-asset="${asset.assetId}">Excluir</button></div></div></article>`;
  }).join('') : emptyState('▧', 'Nenhum arquivo nesta categoria', 'Adicione imagens, GIFs ou documentos à biblioteca geral.');
  $('libraryGrid').querySelectorAll('[data-present-asset]').forEach(button => button.addEventListener('click', () => toggleAssetPresentation(button.dataset.presentAsset)));
  $('libraryGrid').querySelectorAll('[data-delete-library-asset]').forEach(button => button.addEventListener('click', () => deleteLibraryAsset(button.dataset.deleteLibraryAsset)));
}
$('manageLibraryButton').addEventListener('click', showLibraryManager);
$('libraryFilters').querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { state.libraryFilter = button.dataset.filter; $('libraryFilters').querySelectorAll('[data-filter]').forEach(tab => tab.classList.toggle('selected', tab === button)); renderLibrary(); }));
async function removeLibraryAssetData(assetId) {
  const relatedMaps = state.campaign.maps.filter(map => map.assetId === assetId);
  const relatedMapIds = new Set(relatedMaps.map(map => map.id));
  state.campaign.maps = state.campaign.maps.filter(map => map.assetId !== assetId);
  state.campaign.markers = state.campaign.markers.filter(marker => !relatedMapIds.has(marker.mapId));
  state.campaign.markers.forEach(marker => { if (relatedMapIds.has(marker.childMapId)) marker.childMapId = null; });
  state.campaign.editorMapStack = state.campaign.editorMapStack.filter(id => !relatedMapIds.has(id));
  state.campaign.shared.mapStack = (state.campaign.shared.mapStack || []).filter(snapshot => !relatedMapIds.has(snapshot?.id));
  if (relatedMapIds.has(state.campaign.editorMapId)) state.campaign.editorMapId = state.campaign.maps[0]?.id || null;
  if (relatedMapIds.has(state.campaign.shared.mapId)) { state.campaign.shared.mapId = null; state.campaign.shared.mapSnapshot = null; state.campaign.shared.mapStack = []; }
  if (!state.campaign.markers.some(marker => marker.id === state.campaign.shared.focusedMarkerId)) state.campaign.shared.focusedMarkerId = null;
  state.campaign.handouts = state.campaign.handouts.filter(item => item.assetId !== assetId);
  if (state.campaign.shared.presentation?.assetId === assetId) state.campaign.shared.presentation = null;
  await deleteAsset(state.campaign.id, assetId);
  state.assets = state.assets.filter(item => item.assetId !== assetId);
  const url = state.objectUrls.get(assetId); if (url) URL.revokeObjectURL(url); state.objectUrls.delete(assetId);
}
function showLibraryManager() {
  const items = state.assets.filter(asset => ['image','document'].includes(asset.kind)).map(asset => ({ key: asset.assetId, name: asset.name, meta: `${asset.kind === 'image' ? 'Imagem/GIF' : 'Documento'} · ${formatBytes(asset.size)}`, icon: asset.kind === 'image' ? '▧' : '▤' }));
  showBulkManager('Gerenciar arquivos da biblioteca', items, [{ label: 'Excluir selecionados', variant: 'button-primary', run: async selected => confirmBulkDelete('Excluir arquivos?', `Os ${selected.length} arquivos selecionados e suas referências em mapas/handouts serão removidos.`, async () => { for (const id of selected) await removeLibraryAssetData(id); await persist(); try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); } renderAll(); renderPlayerMonitor(); toast('Arquivos selecionados excluídos.'); }) }]);
}
function deleteLibraryAsset(assetId) {
  const asset = state.assets.find(item => item.assetId === assetId); if (!asset) return;
  const relatedMaps = state.campaign.maps.filter(map => map.assetId === assetId);
  const relatedHandouts = state.campaign.handouts.filter(item => item.assetId === assetId);
  const isPresented = state.campaign.shared.presentation?.assetId === assetId;
  modal('Excluir arquivo?', `<div class="settings-note"><strong>${escapeHtml(asset.name)}</strong><br>${relatedMaps.length ? `${relatedMaps.length} mapa(s) usam esta imagem. ` : ''}${relatedHandouts.length ? `${relatedHandouts.length} handout(s) usam este arquivo. ` : ''}${isPresented ? 'Este material está apresentado aos jogadores. ' : ''}As referências serão removidas junto com o arquivo.</div><div class="modal-actions"><button class="button button-secondary" data-modal-cancel>Cancelar</button><button class="button button-primary" id="confirmDeleteLibraryAsset">Excluir arquivo</button></div>`);
  $('confirmDeleteLibraryAsset').addEventListener('click', async () => { await removeLibraryAssetData(assetId); await persist(); try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); } closeModal(); renderAll(); renderPlayerMonitor(); toast('Arquivo excluído da Biblioteca.'); });
}
async function toggleAssetPresentation(assetId) {
  if (state.campaign.shared.presentation?.assetId === assetId) state.campaign.shared.presentation = null;
  else state.campaign.shared.presentation = { type: 'asset', assetId, title: state.assets.find(asset => asset.assetId === assetId)?.name || 'Material' };
  await persist();
  try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); }
  renderLibrary(); renderPlayerMonitor(); toast(state.campaign.shared.presentation ? 'Material apresentado aos jogadores.' : 'Material ocultado.');
}

// ÁUDIO: biblioteca própria organizada somente por álbuns, com barra persistente do mestre.
function audioAssets() { return state.assets.filter(asset => asset.kind === 'audio'); }
function filteredAudioAssets() {
  const tracks = audioAssets();
  if (state.audioFilter.type === 'album') { const album = state.campaign.audioAlbums.find(item => item.id === state.audioFilter.id); return tracks.filter(track => album?.trackIds?.includes(track.assetId)); }
  return tracks;
}
function renderAudio() {
  const tracks = audioAssets();
  $('audioAlbumList').innerHTML = `<button type="button" class="audio-album-button ${state.audioFilter.type === 'all' ? 'active' : ''}" data-audio-filter="all">♫ Todas as músicas <span>${tracks.length}</span></button>` + (state.campaign.audioAlbums.length ? state.campaign.audioAlbums.map(album => `<button type="button" class="audio-album-button ${state.audioFilter.type === 'album' && state.audioFilter.id === album.id ? 'active' : ''}" data-audio-filter="album" data-filter-id="${album.id}">▱ ${escapeHtml(album.name)} <span>${(album.trackIds || []).length}</span></button>`).join('') : '<div class="empty-library-note small-note">Nenhum álbum criado.</div>');
  $('audioAlbumList').querySelectorAll('[data-audio-filter]').forEach(button => button.addEventListener('click', () => { state.audioFilter = { type: button.dataset.audioFilter, id: button.dataset.filterId || null }; renderAudio(); }));
  const filtered = filteredAudioAssets();
  const title = state.audioFilter.type === 'album' ? state.campaign.audioAlbums.find(item => item.id === state.audioFilter.id)?.name || 'Álbum' : 'Todas as músicas';
  $('audioListTitle').textContent = title; $('audioCount').textContent = `${filtered.length} faixa(s)`;
  $('audioTrackList').innerHTML = filtered.length ? filtered.map(track => {
    const belongsTo = state.campaign.audioAlbums.filter(album => (album.trackIds || []).includes(track.assetId)).map(album => album.name);
    const albumLabel = belongsTo.length ? belongsTo.join(' · ') : 'Sem álbum';
    const shownMeta = `${formatBytes(track.size)} · ${albumLabel}${state.campaign.shared.audioTrackId === track.assetId ? ' · Apresentada' : ''}`;
    return `<article class="audio-track-row ${state.selectedAudioId === track.assetId ? 'active' : ''}"><span class="track-icon">♫</span><div class="track-name"><strong>${escapeHtml(track.name)}</strong><small>${escapeHtml(shownMeta)}</small></div><button type="button" class="mini-button" data-track-album="${track.assetId}">Organizar</button><button type="button" class="mini-button" data-play-audio="${track.assetId}">${state.selectedAudioId === track.assetId && !$('audioElement').paused ? 'Ⅱ' : '▶'}</button><button type="button" class="mini-button danger" data-delete-audio="${track.assetId}">Excluir</button></article>`;
  }).join('') : emptyState('♫', 'Nenhuma faixa aqui', 'Adicione músicas ou selecione outro álbum.');
  $('audioTrackList').querySelectorAll('[data-play-audio]').forEach(button => button.addEventListener('click', () => playAudio(button.dataset.playAudio)));
  $('audioTrackList').querySelectorAll('[data-track-album]').forEach(button => button.addEventListener('click', () => addTrackToAlbum(button.dataset.trackAlbum)));
  $('audioTrackList').querySelectorAll('[data-delete-audio]').forEach(button => button.addEventListener('click', () => deleteAudioTrack(button.dataset.deleteAudio)));
  renderAudioDock();
}
$('manageAudioButton').addEventListener('click', showAudioManager);
function showCreateAlbumModal() {
  const tracks = audioAssets();
  modal('Novo álbum', `<form id="audioAlbumForm"><div class="form-field"><label for="audioAlbumName">Nome do álbum</label><input id="audioAlbumName" name="name" required maxlength="70" placeholder="Ex.: AFTERCLASS — Trilha sonora"></div><div class="form-field"><label>Adicionar faixas agora (opcional)</label><div class="album-track-picker">${tracks.length ? tracks.map(track => `<label><input type="checkbox" name="tracks" value="${track.assetId}"> ${escapeHtml(track.name)}</label>`).join('') : '<small class="helper">Adicione músicas à biblioteca primeiro. Você poderá incluí-las no álbum depois.</small>'}</div></div><div class="modal-actions"><button type="button" class="button button-secondary" data-modal-cancel>Cancelar</button><button type="submit" class="button button-primary">Criar álbum</button></div></form>`);
  $('audioAlbumForm').addEventListener('submit', async event => { event.preventDefault(); const data = new FormData(event.currentTarget); state.campaign.audioAlbums.push({ id: uid('album'), name: String(data.get('name')).trim(), trackIds: data.getAll('tracks') }); await persist(); closeModal(); renderAudio(); toast('Álbum criado.'); });
}
function addTrackToAlbum(assetId) {
  const options = state.campaign.audioAlbums.map(album => `<label class="album-check-row"><input type="checkbox" name="albums" value="${album.id}" ${(album.trackIds || []).includes(assetId) ? 'checked' : ''}> ${escapeHtml(album.name)}</label>`).join('');
  modal('Adicionar faixa a um álbum', `<form id="trackAlbumForm">${options || '<div class="empty-library-note">Nenhum álbum criado. Crie um álbum para organizar esta faixa.</div>'}<div class="modal-actions"><button type="button" class="button button-secondary" data-modal-cancel>Cancelar</button><button type="submit" class="button button-primary" ${options ? '' : 'disabled'}>Salvar</button></div></form>`);
  $('trackAlbumForm').addEventListener('submit', async event => { event.preventDefault(); const selected = new Set(new FormData(event.currentTarget).getAll('albums')); state.campaign.audioAlbums.forEach(album => { album.trackIds = album.trackIds.filter(id => id !== assetId); if (selected.has(album.id)) album.trackIds.push(assetId); }); await persist(); closeModal(); renderAudio(); toast('Álbuns atualizados.'); });
}
function showAudioManager() {
  const items = [
    ...state.campaign.audioAlbums.map(album => ({ key: `album:${album.id}`, name: album.name, meta: `Álbum · ${(album.trackIds || []).length} faixa(s)`, icon: '▱' })),
    ...audioAssets().map(track => ({ key: `track:${track.assetId}`, name: track.name, meta: `Música · ${formatBytes(track.size)}`, icon: '♫' }))
  ];
  showBulkManager('Gerenciar biblioteca de áudio', items, [{ label: 'Excluir selecionados', variant: 'button-primary', run: async selected => confirmBulkDelete('Excluir itens de áudio?', `Serão excluídos ${selected.length} itens. Excluir um álbum não apaga as músicas dele.`, async () => {
    const albumIds = selected.filter(key => key.startsWith('album:')).map(key => key.slice(6));
    const trackIds = selected.filter(key => key.startsWith('track:')).map(key => key.slice(6));
    state.campaign.audioAlbums = state.campaign.audioAlbums.filter(album => !albumIds.includes(album.id));
    for (const assetId of trackIds) {
      state.campaign.audioAlbums.forEach(album => album.trackIds = album.trackIds.filter(id => id !== assetId));
      if (state.campaign.shared.audioTrackId === assetId) state.campaign.shared.audioTrackId = null;
      if (state.selectedAudioId === assetId) { $('audioElement').pause(); $('audioElement').removeAttribute('src'); $('audioElement').load(); state.selectedAudioId = null; }
      await deleteAsset(state.campaign.id, assetId); state.assets = state.assets.filter(asset => asset.assetId !== assetId);
      const url = state.objectUrls.get(assetId); if (url) URL.revokeObjectURL(url); state.objectUrls.delete(assetId);
    }
    if (albumIds.includes(state.audioFilter.id)) state.audioFilter = { type: 'all', id: null };
    await persist(); try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); } renderAudio(); renderAudioDock(); renderPlayerMonitor(); toast('Itens de áudio selecionados excluídos.');
  }) }]);
}

async function deleteAudioTrack(assetId) {
  const track = state.assets.find(asset => asset.assetId === assetId); if (!track) return;
  modal('Excluir faixa?', `<div class="settings-note">${escapeHtml(track.name)} será removida da biblioteca de áudio e dos álbuns em que estiver incluída.</div><div class="modal-actions"><button class="button button-secondary" data-modal-cancel>Cancelar</button><button class="button button-primary" id="confirmDeleteTrack">Excluir</button></div>`);
  $('confirmDeleteTrack').addEventListener('click', async () => { state.campaign.audioAlbums.forEach(album => album.trackIds = album.trackIds.filter(id => id !== assetId)); if (state.campaign.shared.audioTrackId === assetId) state.campaign.shared.audioTrackId = null; if (state.selectedAudioId === assetId) { $('audioElement').pause(); $('audioElement').removeAttribute('src'); $('audioElement').load(); state.selectedAudioId = null; } await deleteAsset(state.campaign.id, assetId); state.assets = state.assets.filter(asset => asset.assetId !== assetId); const url = state.objectUrls.get(assetId); if (url) URL.revokeObjectURL(url); state.objectUrls.delete(assetId); await persist(); try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); } closeModal(); renderAudio(); renderAudioDock(); renderPlayerMonitor(); toast('Faixa removida.'); });
}
$('newAudioAlbumButton').addEventListener('click', showCreateAlbumModal);
$('clearAudioFilterButton').addEventListener('click', () => { state.audioFilter = { type: 'all', id: null }; renderAudio(); });
async function publishMasterAudioPlayback() {
  if (!state.campaign || state.role !== 'master' || !state.campaign.shared.audioTrackId || state.campaign.shared.audioTrackId !== state.selectedAudioId) return false;
  const audio = $('audioElement');
  state.campaign.shared.audioPlayback = { ...(state.campaign.shared.audioPlayback || {}), playing: !audio.paused, volume: audio.volume, currentTime: audio.currentTime || 0, updatedAt: Date.now() };
  await persist();
  try { return await publishCurrentMapToPlayers({ silent: true }); }
  catch (error) { console.error('Falha ao sincronizar áudio:', error); toast(authErrorMessage(error)); return false; }
}

async function playAudio(assetId) {
  const asset = state.assets.find(item => item.assetId === assetId && item.kind === 'audio'); if (!asset) return;
  const audio = $('audioElement');
  if (state.selectedAudioId === assetId && !audio.paused) { audio.pause(); renderAudioDock(); renderAudio(); return; }
  const wasPresented = !!state.campaign.shared.audioTrackId;
  if (state.selectedAudioId !== assetId || !audio.src) { state.selectedAudioId = assetId; audio.src = getAssetUrl(asset); audio.load(); }
  try { await audio.play(); } catch { toast('O navegador bloqueou a reprodução. Clique em reproduzir novamente.'); }
  if (wasPresented) {
    state.campaign.shared.audioTrackId = assetId;
    state.campaign.shared.audioPlayback = { playing: !audio.paused, volume: audio.volume, currentTime: audio.currentTime || 0, updatedAt: Date.now() };
    await persist();
    try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); }
  }
  renderAudioDock(); renderAudio();
}

function renderAudioDock() {
  const track = audioAssets().find(item => item.assetId === state.selectedAudioId); const audio = $('audioElement');
  $('dockTrackTitle').textContent = track?.name || 'Nenhuma música selecionada'; $('dockTrackMeta').textContent = track ? `${formatBytes(track.size)} · Biblioteca de áudio` : 'Escolha uma faixa na biblioteca de áudio';
  $('audioPlayButton').textContent = track && !audio.paused ? 'Ⅱ' : '▶';
  const shared = track && state.campaign?.shared.audioTrackId === track.assetId;
  $('audioShareButton').textContent = shared ? 'Ocultar dos jogadores' : 'Apresentar aos jogadores'; $('audioShareButton').classList.toggle('button-primary', !!shared); $('audioShareButton').classList.toggle('button-secondary', !shared);
}
$('audioPlayButton').addEventListener('click', async () => { if (!state.selectedAudioId) { const first = audioAssets()[0]; if (first) await playAudio(first.assetId); else toast('Adicione uma música primeiro.'); } else if ($('audioElement').paused) { try { await $('audioElement').play(); } catch { toast('Não foi possível iniciar o áudio.'); } } else $('audioElement').pause(); renderAudioDock(); renderAudio(); });
$('audioPrevButton').addEventListener('click', () => changeTrack(-1)); $('audioNextButton').addEventListener('click', () => changeTrack(1));
async function changeTrack(direction) { const tracks = filteredAudioAssets().length ? filteredAudioAssets() : audioAssets(); if (!tracks.length) return; let index = tracks.findIndex(item => item.assetId === state.selectedAudioId); index = (index + direction + tracks.length) % tracks.length; await playAudio(tracks[index].assetId); }
$('audioVolume').addEventListener('input', () => { $('audioElement').volume = Number($('audioVolume').value); $('audioVolumeValue').textContent = `${Math.round($('audioElement').volume * 100)}%`; });
$('audioVolume').addEventListener('change', async () => { if (state.campaign?.shared.audioTrackId === state.selectedAudioId) await publishMasterAudioPlayback(); });
$('audioSeek').addEventListener('input', () => { const audio = $('audioElement'); if (audio.duration) audio.currentTime = Number($('audioSeek').value) / 100 * audio.duration; });
$('audioSeek').addEventListener('change', async () => { if (state.campaign?.shared.audioTrackId === state.selectedAudioId) await publishMasterAudioPlayback(); });
$('audioElement').addEventListener('timeupdate', () => { const audio = $('audioElement'); $('audioCurrentTime').textContent = formatTime(audio.currentTime); $('audioDuration').textContent = formatTime(audio.duration); $('audioSeek').value = audio.duration ? audio.currentTime / audio.duration * 100 : 0; });
$('audioElement').addEventListener('play', async () => { renderAudioDock(); renderAudio(); if (state.campaign?.shared.audioTrackId === state.selectedAudioId) await publishMasterAudioPlayback(); });
$('audioElement').addEventListener('pause', async () => { renderAudioDock(); renderAudio(); if (state.campaign?.shared.audioTrackId === state.selectedAudioId) await publishMasterAudioPlayback(); });
$('audioElement').addEventListener('ended', () => changeTrack(1));
$('audioShareButton').addEventListener('click', async () => {
  const track = audioAssets().find(item => item.assetId === state.selectedAudioId);
  if (!track) { toast('Selecione uma música antes de apresentar.'); return; }
  const alreadyShared = state.campaign.shared.audioTrackId === track.assetId;
  state.campaign.shared.audioTrackId = alreadyShared ? null : track.assetId;
  state.campaign.shared.audioPlayback = { playing: !alreadyShared && !$('audioElement').paused, volume: $('audioElement').volume, currentTime: $('audioElement').currentTime || 0, updatedAt: Date.now() };
  await persist();
  try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); }
  renderAudioDock(); renderAudio(); renderPlayerMonitor();
  toast(state.campaign.shared.audioTrackId ? 'Música apresentada aos jogadores.' : 'Música ocultada dos jogadores.');
});

// Fecha o documento que foi aberto a partir de um handout quando ele é ocultado ou excluído.
function clearOpenedHandout(item) {
  if (state.monitorOpenHandoutId === item.id) state.monitorOpenHandoutId = null;
  const presentation = state.campaign.shared.presentation;
  if (presentation?.type === 'asset' && (presentation.handoutId === item.id || (!presentation.handoutId && presentation.assetId === item.assetId))) state.campaign.shared.presentation = null;
}
// HANDOUTS: cada item possui ação explícita de apresentar/ocultar.
function renderHandouts() {
  const handouts = state.campaign.handouts;
  $('handoutGrid').innerHTML = handouts.length ? handouts.map(item => { const asset = state.assets.find(file => file.assetId === item.assetId); return `<article class="handout-card"><div class="handout-card-head"><span class="handout-file-icon">▤</span><div><strong>${escapeHtml(item.title)}</strong><small>${asset ? escapeHtml(asset.name) : 'Arquivo indisponível'}</small></div></div><p>${escapeHtml(item.description || 'Sem descrição adicional.')}</p><span class="handout-status ${item.published ? 'published' : ''}">${item.published ? '● Apresentado aos jogadores' : '○ Oculto dos jogadores'}</span><div class="handout-card-actions"><button type="button" class="mini-button ${item.published ? 'active' : ''}" data-toggle-handout="${item.id}">${item.published ? 'Ocultar' : 'Apresentar'}</button>${item.published ? `<button type="button" class="mini-button" data-refresh-handout="${item.id}">Atualizar</button>` : ''}<button type="button" class="mini-button" data-edit-handout="${item.id}">Editar</button><button type="button" class="mini-button danger" data-delete-handout="${item.id}">Excluir</button></div></article>`; }).join('') : emptyState('▤', 'Nenhum handout preparado', 'Crie um handout com um arquivo da biblioteca.');
  $('handoutGrid').querySelectorAll('[data-toggle-handout]').forEach(button => button.addEventListener('click', async () => { const item = handouts.find(handout => handout.id === button.dataset.toggleHandout); if (!item) return; item.published = !item.published; if (item.published) item.publishedSnapshot = { title: item.title, description: item.description, assetId: item.assetId }; else { item.publishedSnapshot = null; clearOpenedHandout(item); } await persist(); try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); } renderHandouts(); renderPlayerMonitor(); toast(item.published ? 'Handout apresentado.' : 'Handout ocultado e fechado para os jogadores.'); }));
  $('handoutGrid').querySelectorAll('[data-refresh-handout]').forEach(button => button.addEventListener('click', async () => { const item = handouts.find(handout => handout.id === button.dataset.refreshHandout); if (!item) return; item.publishedSnapshot = { title: item.title, description: item.description, assetId: item.assetId }; await persist(); try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); } renderHandouts(); renderPlayerMonitor(); toast('Handout atualizado para os jogadores.'); }));
  $('handoutGrid').querySelectorAll('[data-edit-handout]').forEach(button => button.addEventListener('click', () => editHandout(button.dataset.editHandout)));
  $('handoutGrid').querySelectorAll('[data-delete-handout]').forEach(button => button.addEventListener('click', async () => { const item = handouts.find(handout => handout.id === button.dataset.deleteHandout); if (!item) return; clearOpenedHandout(item); state.campaign.handouts = handouts.filter(entry => entry.id !== item.id); await persist(); try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); } renderHandouts(); renderPlayerMonitor(); toast('Handout excluído e removido da tela dos jogadores.'); }));
}
function showHandoutManager() {
  const items = state.campaign.handouts.map(item => ({ key: item.id, name: item.title, meta: item.published ? 'Apresentado aos jogadores' : 'Oculto dos jogadores', icon: '▤' }));
  showBulkManager('Gerenciar handouts', items, [
    {
      label: 'Apresentar selecionados', variant: 'button-secondary', run: async selected => {
        selected.forEach(id => {
          const item = state.campaign.handouts.find(handout => handout.id === id);
          if (item) { item.published = true; item.publishedSnapshot = { title: item.title, description: item.description, assetId: item.assetId }; }
        });
        await persist();
        try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); }
        renderHandouts(); renderPlayerMonitor(); closeModal(); toast('Handouts apresentados.');
      }
    },
    {
      label: 'Ocultar selecionados', variant: 'button-secondary', run: async selected => {
        selected.forEach(id => {
          const item = state.campaign.handouts.find(handout => handout.id === id);
          if (item) { item.published = false; item.publishedSnapshot = null; clearOpenedHandout(item); }
        });
        await persist();
        try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); }
        renderHandouts(); renderPlayerMonitor(); closeModal(); toast('Handouts ocultados.');
      }
    },
    {
      label: 'Excluir selecionados', variant: 'button-primary', run: async selected => confirmBulkDelete('Excluir handouts?', `Serão excluídos ${selected.length} handout(s). Os arquivos originais da Biblioteca não serão apagados.`, async () => {
        state.campaign.handouts.filter(item => selected.includes(item.id)).forEach(clearOpenedHandout);
        state.campaign.handouts = state.campaign.handouts.filter(item => !selected.includes(item.id));
        await persist();
        try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); }
        renderHandouts(); renderPlayerMonitor(); toast('Handouts excluídos.');
      })
    }
  ]);
}
$('manageHandoutsButton').addEventListener('click', showHandoutManager);
$('addHandoutButton').addEventListener('click', () => editHandout(null));
function editHandout(handoutId, presetAssetId = null) {
  const item = state.campaign.handouts.find(handout => handout.id === handoutId) || { id: uid('handout'), title: '', assetId: presetAssetId, description: '', published: false };
  const options = state.assets.filter(asset => ['document','image'].includes(asset.kind)).map(asset => `<option value="${asset.assetId}" ${item.assetId === asset.assetId ? 'selected' : ''}>${escapeHtml(asset.name)}</option>`).join('');
  modal(handoutId ? 'Editar handout' : 'Criar handout', `<form id="handoutForm"><div class="form-field"><label for="handoutTitle">Título</label><input id="handoutTitle" name="title" value="${escapeHtml(item.title)}" required maxlength="80" placeholder="Ex.: Carta encontrada"></div><div class="form-field"><label for="handoutAsset">Arquivo</label><select id="handoutAsset" name="assetId" required><option value="">Escolha um arquivo da biblioteca</option>${options}</select><label class="button button-secondary upload-label inline-upload">＋ Enviar imagem ou documento<input id="handoutUpload" type="file" accept="image/*,.pdf,.txt,.doc,.docx,.odt" hidden></label><small class="helper">O arquivo enviado será salvo automaticamente na Biblioteca geral e selecionado para este handout.</small></div><div class="form-field"><label for="handoutDescription">Descrição</label><textarea id="handoutDescription" name="description">${escapeHtml(item.description)}</textarea></div><div class="form-check-row"><label><input type="checkbox" name="published" ${item.published ? 'checked' : ''}> Apresentar aos jogadores ao salvar</label></div><div class="modal-actions"><button type="button" class="button button-secondary" data-modal-cancel>Cancelar</button><button type="submit" class="button button-primary">Salvar handout</button></div></form>`);
  $('handoutUpload').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    const [asset] = await addFilesToCampaign([file]);
    const option = document.createElement('option'); option.value = asset.assetId; option.textContent = asset.name;
    $('handoutAsset').append(option); $('handoutAsset').value = asset.assetId;
    toast('Arquivo enviado para a Biblioteca e selecionado para o handout.');
    event.target.value = '';
  });
  $('handoutForm').addEventListener('submit', async event => { event.preventDefault(); const data = new FormData(event.currentTarget); Object.assign(item, { title: String(data.get('title')).trim(), assetId: data.get('assetId'), description: String(data.get('description') || ''), published: data.has('published') }); if (!item.published) { item.publishedSnapshot = null; clearOpenedHandout(item); } else { item.publishedSnapshot = { title: item.title, description: item.description, assetId: item.assetId }; } const index = state.campaign.handouts.findIndex(handout => handout.id === item.id); if (index >= 0) state.campaign.handouts[index] = item; else state.campaign.handouts.push(item); await persist(); try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); } closeModal(); renderHandouts(); renderPlayerMonitor(); toast('Handout salvo.'); });
}
function createHandout(assetId) { editHandout(null, assetId); }

// MONITOR: mostra apenas o que foi publicado. Editar o mapa do mestre não altera esta tela.
function buildPlayerViewHtml() {
  const shared = state.campaign.shared;
  const mapSnapshot = shared.mapSnapshot;
  const mapAsset = mapSnapshot ? state.assets.find(asset => asset.assetId === mapSnapshot.assetId) : null;
  const presentation = shared.presentation?.type === 'asset' ? state.assets.find(asset => asset.assetId === shared.presentation.assetId) : null;
  const audioTrack = audioAssets().find(asset => asset.assetId === shared.audioTrackId);
  const focusedNpc = shared.npcPresentation || null;
  const portrait = focusedNpc?.portraitAssetId ? state.assets.find(asset => asset.assetId === focusedNpc.portraitAssetId) : null;
  const focusedMarker = state.campaign.markers.find(marker => marker.id === shared.focusedMarkerId);
  const handouts = state.campaign.handouts.filter(item => item.published);
  const openHandout = handouts.find(item => item.id === state.monitorOpenHandoutId) || null;
  const openHandoutAsset = openHandout ? state.assets.find(asset => asset.assetId === (openHandout.publishedSnapshot?.assetId || openHandout.assetId)) : null;
  const hasPresentation = !!(mapAsset || presentation || focusedNpc || focusedMarker?.publishedSnapshot || handouts.length || openHandoutAsset || audioTrack);
  let html = '';
  if (mapAsset) {
    const pins = state.campaign.markers.filter(marker => marker.mapId === mapSnapshot.id && marker.visibleToPlayers && marker.publishedSnapshot).map(marker => markerHtml(marker, true)).join('');
    html += `<section class="player-map-card"><div class="monitor-section-title"><strong>${escapeHtml(mapSnapshot.name || 'Mapa apresentado')}</strong><span>MAPA DA CAMPANHA</span></div><div class="player-map-canvas"><div class="monitor-map-stage"><img src="${getAssetUrl(mapAsset)}" alt="${escapeHtml(mapSnapshot.name || 'Mapa apresentado')}">${pins}</div></div>${shared.mapStack.length ? '<button type="button" class="button button-secondary player-back-location" data-player-action="map-back">← Voltar ao local anterior</button>' : ''}</section>`;
  }
  if (presentation) {
    let preview = '';
    if (presentation.kind === 'image') preview = `<img src="${getAssetUrl(presentation)}" alt="${escapeHtml(presentation.name)}">`;
    else if (presentation.mime === 'application/pdf') preview = `<iframe class="player-document-frame" src="${getAssetUrl(presentation)}" title="${escapeHtml(presentation.name)}"></iframe>`;
    else preview = `<a class="player-file-download" href="${getAssetUrl(presentation)}" download="${escapeHtml(presentation.name)}">▤ Abrir ou baixar ${escapeHtml(presentation.name)}</a>`;
    html += `<section class="monitor-section player-presented-section"><div class="monitor-section-title"><strong>${escapeHtml(shared.presentation.title || presentation.name)}</strong><span>MATERIAL APRESENTADO</span></div><div class="monitor-presented">${preview}<small>${escapeHtml(presentation.name)}</small></div></section>`;
  }
  if (focusedNpc) html += `<section class="monitor-section monitor-npc-card">${portrait ? `<div class="monitor-npc-portrait-frame"><img src="${getAssetUrl(portrait)}" alt=""></div>` : ''}<div class="monitor-npc-copy"><div class="player-presentation-heading"><strong>${escapeHtml(focusedNpc.name)}</strong><button type="button" class="button button-secondary button-small" data-player-close-npc="${escapeHtml(focusedNpc.npcId || '')}">Fechar</button></div><p>${escapeHtml(focusedNpc.publicDescription || '')}</p>${focusedNpc.publicRelations ? `<small>Relações: ${escapeHtml(focusedNpc.publicRelations)}</small>` : ''}</div></section>`;
  if (focusedMarker?.publishedSnapshot) html += `<section class="monitor-section"><div class="monitor-section-title"><strong>${escapeHtml(focusedMarker.publishedSnapshot.name)}</strong><span>LOCALIDADE</span></div><p class="monitor-location-description">${escapeHtml(focusedMarker.publishedSnapshot.description || 'Nenhuma descrição foi adicionada.')}</p></section>`;
  if (handouts.length) html += `<section class="monitor-section"><div class="monitor-section-title"><strong>Handouts revelados</strong><span>${handouts.length}</span></div>${handouts.map(item => { const snap = item.publishedSnapshot || { title: item.title, description: item.description, assetId: item.assetId }; const isOpen = state.monitorOpenHandoutId === item.id; return `<button type="button" class="monitor-handout player-handout-button" data-player-open-handout="${item.id}"><strong>${escapeHtml(snap.title)}</strong><small>${escapeHtml(snap.description || 'Abrir material compartilhado')}</small><span>${isOpen ? 'Abrir novamente ↗' : 'Abrir material ↗'}</span></button>`; }).join('')}</section>`;
  if (openHandoutAsset && openHandout) {
    let preview = '';
    if (openHandoutAsset.kind === 'image' || (openHandoutAsset.mime || '').startsWith('image/')) preview = `<img class="player-presented-image" src="${getAssetUrl(openHandoutAsset)}" alt="${escapeHtml(openHandout.title)}">`;
    else if (openHandoutAsset.mime === 'application/pdf') preview = `<iframe class="player-document-frame" src="${getAssetUrl(openHandoutAsset)}" title="${escapeHtml(openHandout.title)}"></iframe>`;
    else preview = `<a class="player-file-download" href="${getAssetUrl(openHandoutAsset)}" download="${escapeHtml(openHandoutAsset.name)}">▤ Abrir ou baixar ${escapeHtml(openHandoutAsset.name)}</a>`;
    html += `<section class="monitor-section player-open-handout"><div class="player-presentation-heading"><strong>${escapeHtml(openHandout.title)}</strong><button type="button" class="button button-secondary button-small" data-player-close-handout>Fechar documento</button></div><div class="player-presentation-body">${preview}</div><small>${escapeHtml(openHandout.description || '')}</small></section>`;
  }
  if (audioTrack) {
    const playback = shared.audioPlayback || {};
    html += `<section class="monitor-audio player-audio-status"><span class="monitor-audio-icon">♫</span><div><strong>${escapeHtml(audioTrack.name)}</strong><small>${playback.playing ? 'Reproduzindo' : 'Em pausa'} · Música controlada pelo mestre</small></div><span class="monitor-audio-live">${playback.playing ? '●' : 'Ⅱ'}</span></section>`;
  }
  if (!hasPresentation) html = `<div class="player-empty"><span>◉</span><strong>Nada apresentado ainda</strong><p>O mestre ainda não compartilhou mapas, personagens ou materiais com a mesa.</p></div>`;
  return html;
}
function bindPlayerViewInteractions(root) {
  root.querySelectorAll('[data-player-marker]').forEach(button => button.addEventListener('click', () => handlePlayerMarkerClick(button.dataset.playerMarker)));
  root.querySelectorAll('[data-player-action="map-back"]').forEach(button => button.addEventListener('click', playerMapBack));
  root.querySelectorAll('[data-player-open-handout]').forEach(button => button.addEventListener('click', () => {
    const item = state.campaign.handouts.find(handout => handout.id === button.dataset.playerOpenHandout && handout.published);
    if (!item) return;
    state.monitorOpenHandoutId = item.id;
    renderPlayerMonitor();
  }));
  root.querySelectorAll('[data-player-close-handout]').forEach(button => button.addEventListener('click', () => {
    state.monitorOpenHandoutId = null;
    renderPlayerMonitor();
  }));
  root.querySelectorAll('[data-player-close-npc]').forEach(button => button.addEventListener('click', async () => {
    const npcId = button.dataset.playerCloseNpc;
    const focusedId = state.campaign.shared.npcPresentation?.npcId || state.campaign.shared.focusedNpcId;
    if (!focusedId || focusedId !== npcId) return;
    state.campaign.shared.focusedNpcId = null;
    state.campaign.shared.npcPresentation = null;
    await persist();
    try { await publishCurrentMapToPlayers({ silent: true }); } catch (error) { console.error(error); toast(authErrorMessage(error)); }
    renderPlayerMonitor();
  }));
}
function renderPlayerMonitor() {
  if (!state.campaign) return;
  const html = buildPlayerViewHtml();
  $('playerMonitorBody').innerHTML = html;
  bindPlayerViewInteractions($('playerMonitorBody'));
  $('playerScreenBody').innerHTML = html;
  bindPlayerViewInteractions($('playerScreenBody'));
  $('playerScreenCampaignName').textContent = state.campaign.name;
}
function openPlayerView() {
  if (state.role === 'player' && state.currentSession?.isOnline) {
    renderRemotePlayerSession();
  } else {
    if (!state.campaign) return;
    renderPlayerMonitor();
  }
  $('playerViewScreen').classList.remove('hidden');
  document.body.classList.add('player-view-open');
}
async function closePlayerView() {
  if (state.role === 'player' && state.currentSession?.isOnline) {
    await leaveOnlineSession();
    return;
  }
  $('playerViewScreen').classList.add('hidden');
  document.body.classList.remove('player-view-open');
}
$('playerPreviewButton').addEventListener('click', openPlayerView);
$('closePlayerViewButton').addEventListener('click', closePlayerView);
$('expandPlayerMonitorButton').addEventListener('click', () => { state.monitorExpanded = !state.monitorExpanded; $('playerMonitor').classList.toggle('expanded', state.monitorExpanded); $('expandPlayerMonitorButton').textContent = state.monitorExpanded ? 'Reduzir prévia' : 'Ampliar prévia'; });

async function handlePlayerMarkerClick(markerId) {
  const marker = state.campaign.markers.find(item => item.id === markerId); const view = marker?.publishedSnapshot;
  if (!marker || !marker.visibleToPlayers || !view?.playerClickable) return;
  if (view.type === 'npc') {
    state.campaign.shared.focusedNpcId = view.npcId;
    state.campaign.shared.npcPresentation = { npcId: view.npcId, name: view.name, portraitAssetId: view.portraitAssetId || null, publicDescription: view.publicDescription || '', publicRelations: view.publicRelations || '' };
  } else if (view.childMapId && getMap(view.childMapId)) {
    if (state.campaign.shared.mapSnapshot) state.campaign.shared.mapStack.push(state.campaign.shared.mapSnapshot);
    const child = getMap(view.childMapId); state.campaign.shared.mapId = child.id; state.campaign.shared.mapSnapshot = { id: child.id, assetId: child.assetId, name: child.name };
    state.campaign.shared.focusedNpcId = null; state.campaign.shared.npcPresentation = null; state.campaign.shared.focusedMarkerId = null;
  } else state.campaign.shared.focusedMarkerId = marker.id;
  await persist();
  renderPlayerMonitor();
  await publishCurrentMapToPlayers({ silent: true });
}
async function playerMapBack() {
  const previous = state.campaign.shared.mapStack.pop(); if (!previous) return;
  state.campaign.shared.mapId = previous.id; state.campaign.shared.mapSnapshot = previous;
  state.campaign.shared.focusedNpcId = null; state.campaign.shared.npcPresentation = null; state.campaign.shared.focusedMarkerId = null;
  await persist(); renderPlayerMonitor(); await publishCurrentMapToPlayers({ silent: true });
}

// BACKUP COMPLETO: campanha, mapas, NPCs, álbuns, handouts e todas as bibliotecas locais.
async function blobToDataUrl(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); }); }
async function dataUrlToBlob(dataUrl) { const response = await fetch(dataUrl); return response.blob(); }
async function exportBackup() {
  if (!state.campaign) return;
  const assets = await getAssets(state.campaign.id); const serializedAssets = [];
  for (const asset of assets) serializedAssets.push({ assetId: asset.assetId, name: asset.name, mime: asset.mime, size: asset.size, kind: asset.kind, createdAt: asset.createdAt, dataUrl: await blobToDataUrl(asset.blob) });
  const payload = { format: 'astronic-tabletop-backup', version: 2, exportedAt: new Date().toISOString(), campaign: state.campaign, assets: serializedAssets };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${state.campaign.name.replace(/[^a-z0-9-_]+/gi, '-').replace(/-+/g, '-') || 'campanha'}-backup.astronic.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1800); toast('Backup completo exportado.');
}
function showBackupModal() {
  const count = state.assets.length; const total = state.assets.reduce((sum, asset) => sum + (asset.size || 0), 0);
  modal('Backup da campanha', `<p class="settings-note">O backup reúne os dados da campanha e todos os arquivos locais: mapas, retratos exclusivos de NPCs, músicas organizadas em álbuns, handouts e apresentações. Guarde o arquivo fora deste dispositivo.</p><div class="backup-summary"><div class="backup-stat"><strong>${count}</strong><small>Arquivos de mídia</small></div><div class="backup-stat"><strong>${formatBytes(total)}</strong><small>Tamanho aproximado</small></div><div class="backup-stat"><strong>${state.campaign.npcs.length}</strong><small>NPCs cadastrados</small></div><div class="backup-stat"><strong>${state.campaign.maps.length}</strong><small>Mapas cadastrados</small></div></div><div class="modal-actions" style="justify-content:space-between"><label class="button button-secondary upload-label">Restaurar backup<input id="restoreBackupInput" type="file" accept=".json,.astronic.json,application/json" hidden></label><button id="exportBackupNow" class="button button-primary">⇩ Exportar backup</button></div>`);
  $('exportBackupNow').addEventListener('click', async () => { closeModal(); await exportBackup(); });
  $('restoreBackupInput').addEventListener('change', async event => { const file = event.target.files?.[0]; if (file) { closeModal(); await restoreBackup(file); } });
}
async function restoreBackup(file) {
  try {
    const payload = JSON.parse(await file.text());
    if (payload.format !== 'astronic-tabletop-backup' || ![1,2].includes(payload.version) || !payload.campaign || !Array.isArray(payload.assets)) throw new Error('Este arquivo não parece ser um backup válido do Astronic Tabletop.');
    const campaign = normalizeCampaign(payload.campaign); const assets = [];
    for (const item of payload.assets) { const blob = await dataUrlToBlob(item.dataUrl); assets.push({ assetId: item.assetId, campaignId: campaign.id, name: item.name, mime: item.mime, size: item.size, kind: item.kind, createdAt: item.createdAt, blob }); }
    await replaceCampaignAndAssets(campaign, assets); await loadCampaign(campaign); toast('Backup restaurado com sucesso.');
  } catch (error) { toast(error.message || 'Não foi possível restaurar o backup.'); }
}
$('backupButton').addEventListener('click', showBackupModal);
// ACESSO E SESSÕES — Firebase Authentication + Realtime Database.
const ACCESS_STORE_KEY = 'astronic-tabletop-firebase-access-v1';
const PENDING_MASTER_KEY = 'astronic-tabletop-pending-master-v1';
let authMode = 'login';
let selectedAuthRole = 'master';

function readSavedAccess() {
  try { return JSON.parse(localStorage.getItem(ACCESS_STORE_KEY) || 'null'); } catch { return null; }
}
function saveAccess(user, role, sessionCode = null) {
  localStorage.setItem(ACCESS_STORE_KEY, JSON.stringify({ uid: user.uid, role, sessionCode }));
}
function showAuthError(message = '') { $('authError').textContent = message; }
function authErrorMessage(error) {
  const code = error?.code || '';
  const messages = {
    'auth/email-already-in-use': 'Este e-mail já possui uma conta. Selecione “Entrar”.',
    'auth/invalid-email': 'Digite um endereço de e-mail válido.',
    'auth/weak-password': 'A senha precisa ter pelo menos 6 caracteres.',
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/user-disabled': 'Esta conta foi desativada.',
    'auth/too-many-requests': 'Muitas tentativas. Aguarde um pouco e tente novamente.',
    'auth/network-request-failed': 'Não foi possível conectar ao Firebase. Confira sua internet.',
    'PERMISSION_DENIED': 'O Firebase recusou o acesso. Confira se publicou o arquivo database.rules.json na aba Regras do Realtime Database.'
  };
  return messages[code] || error?.message || 'Não foi possível concluir o acesso.';
}
function setAuthMode(mode) {
  authMode = mode;
  $('authLoginTab').classList.toggle('selected', mode === 'login');
  $('authRegisterTab').classList.toggle('selected', mode === 'register');
  $('authNameField').classList.toggle('hidden', mode !== 'register');
  $('authConfirmField').classList.toggle('hidden', mode !== 'register');
  $('authPassword').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('authSubmitButton').textContent = mode === 'register' ? 'Criar conta' : `Entrar como ${selectedAuthRole === 'master' ? 'mestre' : 'jogador'}`;
  showAuthError('');
}
function setAuthRole(role) {
  selectedAuthRole = role;
  document.querySelectorAll('[data-auth-role]').forEach(button => button.classList.toggle('selected', button.dataset.authRole === selectedAuthRole));
  $('authSubmitButton').textContent = authMode === 'register' ? 'Criar conta' : `Entrar como ${selectedAuthRole === 'master' ? 'mestre' : 'jogador'}`;
}
function showAuthGate() {
  $('authGate').classList.remove('hidden');
  $('welcomeScreen').classList.add('hidden');
  $('playerJoinScreen').classList.add('hidden');
  $('sessionCenterScreen').classList.add('hidden');
  $('appShell').classList.add('hidden');
  $('playerViewScreen').classList.add('hidden');
  $('masterActivationPanel').classList.add('hidden');
  $('authForm').classList.remove('hidden');
  $('authModeTabs').classList.remove('hidden');
  $('authRolePicker').classList.remove('hidden');
  document.body.classList.remove('player-role', 'player-view-open');
  setAuthRole('master');
  setAuthMode('login');
  $('authEmail').value = '';
  $('authPassword').value = '';
  $('authName').value = '';
  $('authPasswordConfirm').value = '';
}
function showMasterActivation(user) {
  state.user = { id: user.uid, uid: user.uid, name: user.displayName || user.email?.split('@')[0] || 'Mestre', email: user.email || '' };
  state.role = null;
  localStorage.setItem(PENDING_MASTER_KEY, JSON.stringify({ uid: user.uid }));
  $('authGate').classList.remove('hidden');
  $('authForm').classList.add('hidden');
  $('authRolePicker').classList.add('hidden');
  $('authModeTabs').classList.add('hidden');
  $('masterActivationPanel').classList.remove('hidden');
  $('masterActivationUid').textContent = user.uid;
  $('masterActivationMessage').textContent = 'Sua conta Firebase foi criada. Falta autorizar esta conta como mestre no Realtime Database. Copie o UID abaixo e siga as instruções do arquivo FIREBASE-SETUP.md.';
  $('welcomeScreen').classList.add('hidden');
  $('playerJoinScreen').classList.add('hidden');
  $('appShell').classList.add('hidden');
  $('sessionCenterScreen').classList.add('hidden');
  $('playerViewScreen').classList.add('hidden');
}
async function completeFirebaseAccess(firebaseUser, profile, role, sessionCode = null) {
  const name = profile?.displayName || firebaseUser.displayName || (firebaseUser.email || 'Usuário').split('@')[0];
  state.user = { id: firebaseUser.uid, uid: firebaseUser.uid, name, displayName: name, email: firebaseUser.email || profile?.email || '' };
  state.role = role;
  state.currentSession = null;
  state.remoteSessionEnded = false;
  saveAccess(firebaseUser, role, sessionCode);
  localStorage.removeItem(PENDING_MASTER_KEY);
  $('accountBadge').textContent = `${name} · ${role === 'master' ? 'Mestre' : 'Jogador'}`;
  const modeBadge = document.querySelector('.local-badge');
  if (modeBadge) { modeBadge.innerHTML = '<span class="status-dot"></span> Conectado ao Firebase'; modeBadge.classList.add('firebase-connected-badge'); }
  $('authGate').classList.add('hidden');
  if (role === 'player') {
    state.campaign = null;
    state.assets = [];
    revokeObjectUrls();
    showPlayerJoinScreen();
    const codeToJoin = sessionCode;
    if (codeToJoin) await joinSessionByCode(codeToJoin);
    return;
  }
  document.body.classList.remove('player-role', 'player-view-open');
  $('playerJoinScreen').classList.add('hidden');
  const campaigns = await getCampaigns();
  if (campaigns.length) {
    await loadCampaign(campaigns[0]);
    try {
      const active = await getMasterActiveSession(firebaseUser.uid, state.campaign.id);
      if (active) { state.currentSession = active; await startMasterSyncForSession(active); }
    } catch (error) { console.warn('Não foi possível restaurar a sincronização da sessão:', error); }
  } else {
    $('appShell').classList.add('hidden');
    $('welcomeScreen').classList.remove('hidden');
  }
}
function showPlayerJoinScreen() {
  $('authGate').classList.add('hidden');
  $('welcomeScreen').classList.add('hidden');
  $('appShell').classList.add('hidden');
  $('sessionCenterScreen').classList.add('hidden');
  $('playerJoinScreen').classList.remove('hidden');
  $('playerSessionCode').value = '';
  $('playerJoinMessage').textContent = '';
  document.body.classList.add('player-role');
}
function showPlayerAuthMessage(message) {
  $('playerJoinMessage').textContent = message;
}
$('authLoginTab').addEventListener('click', () => setAuthMode('login'));
$('authRegisterTab').addEventListener('click', () => setAuthMode('register'));
document.querySelectorAll('[data-auth-role]').forEach(button => button.addEventListener('click', () => setAuthRole(button.dataset.authRole)));
$('authForm').addEventListener('submit', async event => {
  event.preventDefault();
  const email = $('authEmail').value.trim().toLowerCase();
  const password = $('authPassword').value;
  const role = selectedAuthRole;
  $('authSubmitButton').disabled = true;
  $('authSubmitButton').textContent = authMode === 'register' ? 'Criando conta…' : 'Entrando…';
  showAuthError('');
  try {
    let result;
    if (authMode === 'register') {
      const name = $('authName').value.trim();
      if (!name) throw new Error('Digite o nome que será exibido na sessão.');
      if (password.length < 6) throw new Error('A senha precisa ter pelo menos 6 caracteres.');
      if (password !== $('authPasswordConfirm').value) throw new Error('As senhas não coincidem.');
      result = await registerFirebaseAccount(email, password, name);
    } else {
      result = await loginFirebaseAccount(email, password);
    }

    if (role === 'master' && !(await isAuthorizedMaster(result.user.uid))) {
      showMasterActivation(result.user);
      return;
    }
    await completeFirebaseAccess(result.user, result.profile, role, null);
  } catch (error) {
    console.error(error);
    showAuthError(authErrorMessage(error));
  } finally {
    $('authSubmitButton').disabled = false;
    if (!$('masterActivationPanel').classList.contains('hidden')) $('authSubmitButton').textContent = 'Criar conta';
    else $('authSubmitButton').textContent = authMode === 'register' ? 'Criar conta' : `Entrar como ${selectedAuthRole === 'master' ? 'mestre' : 'jogador'}`;
  }
});
$('copyMasterUidButton').addEventListener('click', () => copyText($('masterActivationUid').textContent, 'UID copiado.'));
$('verifyMasterAccessButton').addEventListener('click', async () => {
  const button = $('verifyMasterAccessButton');
  button.disabled = true;
  button.textContent = 'Verificando…';
  try {
    const user = auth.currentUser;
    if (!user) throw new Error('Sua sessão de login expirou. Entre novamente.');
    if (!(await isAuthorizedMaster(user.uid))) throw new Error('A autorização ainda não apareceu no banco. Confira se salvou masterUsers / seu UID com o valor booleano true na aba Dados.');
    const profile = await getFirebaseProfile(user.uid);
    selectedAuthRole = 'master';
    await completeFirebaseAccess(user, profile || {}, 'master');
  } catch (error) {
    $('masterActivationMessage').textContent = authErrorMessage(error);
  } finally {
    button.disabled = false;
    button.textContent = 'Já autorizei — verificar novamente';
  }
});
async function stopSessionWatchers() {
  if (state.sessionParticipantsUnsubscribe) state.sessionParticipantsUnsubscribe();
  if (state.playerSessionInfoUnsubscribe) state.playerSessionInfoUnsubscribe();
  if (state.playerPublishedStateUnsubscribe) state.playerPublishedStateUnsubscribe();
  if (state.playerRtcOffersUnsubscribe) state.playerRtcOffersUnsubscribe();
  state.sessionParticipantsUnsubscribe = null;
  state.playerSessionInfoUnsubscribe = null;
  state.playerPublishedStateUnsubscribe = null;
  state.playerRtcOffersUnsubscribe = null;
  state.sessionListenerId = null;
  for (const connection of state.masterPeerConnections.values()) closeRtcConnection(connection);
  for (const connection of state.playerPeerConnections.values()) closeRtcConnection(connection);
  state.masterPeerConnections.clear();
  state.playerPeerConnections.clear();
  state.playerRtcOfferIds.clear();
  state.remoteIncomingTransfers.clear();
  state.remoteConnectionError = false;
  state.lastPublishedMapState = null;
  state.remotePublishedState = null;
  state.remoteOpenHandoutId = null;
  stopRemoteAudio(true);
  clearRemoteAssets();
}
async function signOutLocal() {
  try {
    if (state.role === 'player' && state.currentSession?.isOnline && state.user?.uid) {
      await leaveFirebaseSession(state.currentSession.id, state.user.uid);
    }
    await stopSessionWatchers();
    await logoutFirebaseAccount();
  } catch (error) { console.warn('Falha ao finalizar listeners ou sessão Firebase:', error); }
  localStorage.removeItem(ACCESS_STORE_KEY);
  localStorage.removeItem(PENDING_MASTER_KEY);
  state.user = null; state.role = null; state.currentSession = null; state.campaign = null; state.assets = [];
  if (!$('playerViewScreen').classList.contains('hidden')) $('playerViewScreen').classList.add('hidden');
  showAuthGate();
}
$('logoutButton').addEventListener('click', signOutLocal);
$('welcomeLogoutButton').addEventListener('click', signOutLocal);
$('playerJoinLogoutButton').addEventListener('click', signOutLocal);
$('masterActivationLogoutButton').addEventListener('click', signOutLocal);

async function copyText(text, successMessage) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const temporary = document.createElement('textarea'); temporary.value = text; temporary.style.position = 'fixed'; temporary.style.opacity = '0'; document.body.appendChild(temporary); temporary.select();
      if (!document.execCommand('copy')) throw new Error('A cópia automática não está disponível.');
      temporary.remove();
    }
    toast(successMessage);
  } catch { toast('Não foi possível copiar automaticamente. Selecione e copie o texto.'); }
}
function renderParticipantRows(participants = []) {
  return participants.map(participant => `<div class="session-participant-row"><span class="session-participant-avatar">${escapeHtml((participant.displayName || '?').slice(0,1).toUpperCase())}</span><div class="session-participant-copy"><strong>${escapeHtml(participant.displayName || 'Participante')}</strong><small>Conectado à sessão</small></div><span class="session-role-pill">${participant.role === 'master' ? 'Mestre' : 'Jogador'}</span></div>`).join('') || '<div class="empty-list">Nenhum participante na sala.</div>';
}
function updateParticipantList(participants = []) {
  const list = $('sessionParticipantList');
  const count = $('sessionParticipantCount');
  if (list) list.innerHTML = renderParticipantRows(participants);
  if (count) count.textContent = `${participants.length} pessoa(s) na sala`;
}
function findLocalCampaignRequirement() {
  if (!state.campaign) throw new Error('Abra uma campanha antes de criar uma sessão online.');
}
function openSessionCenter() {
  if (state.role !== 'master') { toast('A central de sessões está disponível para o mestre.'); return; }
  $('sessionCenterScreen').classList.remove('hidden');
  renderSessionCenter();
}
async function renderSessionCenter() {
  const token = ++state.sessionRenderToken;
  const host = $('sessionCenterBody');
  if (!state.campaign) {
    host.innerHTML = `<section class="session-hub-card"><div class="session-empty-state"><span>✦</span><strong>Abra uma campanha primeiro</strong><p>Uma sessão online sempre está vinculada a uma campanha. Crie ou abra uma para continuar.</p><button type="button" class="button button-primary" id="sessionCreateCampaignButton">＋ Criar campanha</button></div></section>`;
    $('sessionCreateCampaignButton').addEventListener('click', () => { $('sessionCenterScreen').classList.add('hidden'); showCreateCampaignModal(); });
    return;
  }

  host.innerHTML = '<section class="session-hub-card"><div class="session-empty-state"><strong>Carregando sessão…</strong><p>Consultando o Firebase.</p></div></section>';
  try {
    const active = await getMasterActiveSession(state.user.uid, state.campaign.id);
    const history = await getMasterSessionHistory(state.user.uid, state.campaign.id);
    if (token !== state.sessionRenderToken) return;
    state.currentSession = active;
    const campaignLabel = `<span class="session-campaign-label">Campanha · ${escapeHtml(state.campaign.name)}</span>`;
    let mainCard;
    if (!active) {
      if (state.sessionParticipantsUnsubscribe) state.sessionParticipantsUnsubscribe();
      state.sessionParticipantsUnsubscribe = null;
      state.sessionListenerId = null;
      for (const connection of state.masterPeerConnections.values()) closeRtcConnection(connection);
      state.masterPeerConnections.clear();
      state.lastPublishedMapState = null;
      state.currentSession = null;
      mainCard = `<section class="session-hub-card">${campaignLabel}<div class="session-empty-state"><span>⌁</span><strong>Nenhuma sessão ativa</strong><p>Crie uma sala online e compartilhe o código com seus jogadores.</p><button type="button" class="button button-primary button-large" id="createOnlineSessionButton">＋ Criar sessão online</button></div><div class="session-demo-warning">Conectado ao Firebase. O mapa apresentado será sincronizado com os jogadores; a transferência usa conexão direta entre navegadores.</div></section>`;
    } else {
      mainCard = `<section class="session-hub-card">${campaignLabel}<div class="session-status-line"><span class="status-dot"></span> Sessão online ativa · Criada em ${new Date(active.createdAt).toLocaleString('pt-BR')}</div><div class="session-created-layout" style="margin-top:15px"><div class="session-code-panel"><span class="eyebrow">CÓDIGO DE CONVITE</span><div class="session-code">${escapeHtml(active.code)}</div><div class="session-actions"><button type="button" class="button button-primary" id="copySessionCodeButton">Copiar código</button></div><p class="session-code-help">Envie este código aos jogadores. Eles entram escolhendo o perfil Jogador e digitando o código na tela de entrada.</p></div><div><div class="side-panel-heading"><div><strong>Participantes</strong><span id="sessionParticipantCount">${active.participants.length} pessoa(s) na sala</span></div><button type="button" class="button button-secondary button-small" id="refreshSessionParticipantsButton">Atualizar</button></div><div class="session-participant-list" id="sessionParticipantList">${renderParticipantRows(active.participants)}</div></div></div><div class="session-actions"><button type="button" class="button button-delete" id="endOnlineSessionButton">Encerrar sessão</button></div><div class="session-demo-warning">Esta sala está salva no Firebase. Mapas apresentados são sincronizados; o envio do arquivo ocorre diretamente entre o navegador do mestre e os jogadores.</div></section>`;
    }
    const historyCard = history.length ? `<section class="session-hub-card"><h2>Sessões anteriores</h2><div class="session-history">${history.slice(0,8).map(item => `<div class="session-history-row"><div><strong>${escapeHtml(item.code || 'Sessão')}</strong><small>${new Date(item.createdAt || item.endedAt).toLocaleString('pt-BR')} · ${Number(item.participantCount || 0)} participante(s)</small></div><span class="session-role-pill">Encerrada</span></div>`).join('')}</div></section>` : '';
    host.innerHTML = mainCard + historyCard;

    if (!active) {
      $('createOnlineSessionButton').addEventListener('click', createOnlineSession);
      return;
    }
    $('copySessionCodeButton').addEventListener('click', () => copyText(active.code, 'Código de convite copiado.'));
    $('refreshSessionParticipantsButton').addEventListener('click', renderSessionCenter);
    if (state.sessionListenerId !== active.id) await startMasterSyncForSession(active);
    $('endOnlineSessionButton').addEventListener('click', () => {
      modal('Encerrar sessão?', `<div class="settings-note">Os jogadores não poderão continuar entrando usando o código <b>${escapeHtml(active.code)}</b>. A campanha e os arquivos locais permanecerão salvos.</div><div class="modal-actions"><button type="button" class="button button-secondary" data-modal-cancel>Continuar sessão</button><button type="button" class="button button-delete" id="confirmEndOnlineSession">Encerrar sessão</button></div>`);
      $('confirmEndOnlineSession').addEventListener('click', async () => {
        const button = $('confirmEndOnlineSession'); button.disabled = true; button.textContent = 'Encerrando…';
        try {
          await endFirebaseSession(active);
          await stopSessionWatchers();
          state.currentSession = null;
          closeModal(); await renderSessionCenter(); toast('Sessão encerrada. A campanha continua salva.');
        } catch (error) {
          console.error(error); button.disabled = false; button.textContent = 'Tentar novamente'; toast(authErrorMessage(error));
        }
      });
    });
  } catch (error) {
    console.error(error);
    if (token !== state.sessionRenderToken) return;
    host.innerHTML = `<section class="session-hub-card"><div class="session-empty-state"><strong>Não foi possível consultar as sessões</strong><p>${escapeHtml(authErrorMessage(error))}</p><p>Confira se as regras do Realtime Database já foram publicadas.</p><button type="button" class="button button-secondary" id="retrySessionCenterButton">Tentar novamente</button></div></section>`;
    $('retrySessionCenterButton').addEventListener('click', renderSessionCenter);
  }
}
async function createOnlineSession() {
  if (state.role !== 'master' || !state.campaign) return;
  const button = $('createOnlineSessionButton');
  if (button) { button.disabled = true; button.textContent = 'Criando sala…'; }
  try {
    state.currentSession = await createFirebaseSession({ campaign: state.campaign, user: state.user });
    await renderSessionCenter();
    toast('Sessão criada no Firebase. Compartilhe o código com os jogadores.');
  } catch (error) {
    console.error(error);
    toast(authErrorMessage(error));
    if (button) { button.disabled = false; button.textContent = '＋ Criar sessão online'; }
  }
}
function renderRemotePlayerSession() {
  const session = state.currentSession;
  $('playerScreenCampaignName').textContent = session?.campaignName || 'Sessão online';
  if (!session) {
    $('playerScreenBody').innerHTML = '<div class="player-empty"><span>◉</span><strong>Nenhuma sessão conectada</strong><p>Entre usando um código de convite enviado pelo mestre.</p></div>';
    return;
  }
  if (session.status === 'ended' || state.remoteSessionEnded) {
    stopRemoteAudio(true); state.remoteOpenHandoutId = null;
    $('playerScreenBody').innerHTML = `<div class="player-empty"><span>⌁</span><strong>Esta sessão foi encerrada</strong><p>O mestre encerrou a sessão. Você pode sair e usar outro código para entrar em uma nova mesa.</p></div>`;
    return;
  }
  const currentHandouts = state.remotePublishedState?.handouts || [];
  if (state.remoteOpenHandoutId && !currentHandouts.some(item => item.id === state.remoteOpenHandoutId)) state.remoteOpenHandoutId = null;
  $('playerScreenBody').innerHTML = buildRemotePublishedHtml();
  bindRemotePublishedInteractions($('playerScreenBody'));
}
async function joinSessionByCode(rawCode) {
  const code = String(rawCode || '').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 8);
  if (!code) { showPlayerAuthMessage('Digite o código de convite.'); return; }
  const submit = $('playerJoinForm').querySelector('button[type="submit"]');
  submit.disabled = true; submit.textContent = 'Entrando…'; showPlayerAuthMessage('');
  try {
    const session = await joinFirebaseSessionByCode(code, auth.currentUser || state.user);
    await stopSessionWatchers();
    state.currentSession = { ...session, isOnline: true };
    state.role = 'player'; state.campaign = null; state.assets = []; state.remoteSessionEnded = false; state.remotePublishedState = null; state.remoteConnectionError = false;
    clearRemoteAssets();
    state.pendingPlayerMapActions = [];
    state.remoteDismissedNpcId = null; state.remoteDismissedNpcPublishedAt = null;
    stopRemoteAudio(true); state.remoteOpenHandoutId = null;
    revokeObjectUrls();
    saveAccess(auth.currentUser || state.user, 'player', code);
    $('playerJoinScreen').classList.add('hidden'); $('appShell').classList.add('hidden');
    document.body.classList.add('player-role');
    $('closePlayerViewButton').textContent = 'Sair da sessão';
    renderRemotePlayerSession();
    $('playerViewScreen').classList.remove('hidden');
    document.body.classList.add('player-view-open');
    state.playerSessionInfoUnsubscribe = watchFirebaseSessionInfo(session.id, info => {
      if (!info) return;
      state.currentSession = { ...state.currentSession, ...info };
      state.remoteSessionEnded = info.status !== 'active';
      renderRemotePlayerSession();
    }, error => { console.error(error); showPlayerAuthMessage('A conexão com a sessão foi interrompida.'); });
    attachRemoteMapStateListener(session);
    startPlayerRtcListener(session);
    toast(`Você entrou na sessão ${code}.`);
  } catch (error) {
    console.error(error);
    showPlayerAuthMessage(authErrorMessage(error));
  } finally {
    submit.disabled = false; submit.textContent = 'Entrar na sessão';
  }
}
async function leaveOnlineSession() {
  const sessionId = state.currentSession?.id;
  const uid = state.user?.uid;
  try { await stopSessionWatchers(); if (sessionId && uid) await leaveFirebaseSession(sessionId, uid); }
  catch (error) { console.warn('Não foi possível registrar a saída da sala:', error); }
  state.currentSession = null; state.remoteSessionEnded = false; state.pendingPlayerMapActions = []; state.remoteRequestedAssetRevisions.clear();
  const access = readSavedAccess(); if (access?.uid === uid) saveAccess(auth.currentUser || state.user, 'player', null);
  $('playerViewScreen').classList.add('hidden'); document.body.classList.remove('player-view-open');
  showPlayerJoinScreen();
}
$('playerJoinForm').addEventListener('submit', async event => { event.preventDefault(); await joinSessionByCode($('playerSessionCode').value); });
$('playerSessionCode').addEventListener('input', () => { $('playerSessionCode').value = $('playerSessionCode').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); });
$('closeSessionCenterButton').addEventListener('click', () => $('sessionCenterScreen').classList.add('hidden'));
function showSettings() { openSessionCenter(); }
$('settingsButton').addEventListener('click', showSettings);
$('createCampaignButton').addEventListener('click', showCreateCampaignModal); $('openCampaignsButton').addEventListener('click', showCampaignList); $('switchCampaignButton').addEventListener('click', showCampaignList);

async function init() {
  $('audioElement').volume = 0.7;
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch { /* opcional */ }
  try {
    await getCampaigns();
    const firebaseUser = await waitForAuthUser();
    if (!firebaseUser) { showAuthGate(); return; }

    const pendingMaster = (() => { try { return JSON.parse(localStorage.getItem(PENDING_MASTER_KEY) || 'null'); } catch { return null; } })();
    if (pendingMaster?.uid === firebaseUser.uid) {
      showMasterActivation(firebaseUser);
      return;
    }

    const remembered = readSavedAccess();
    let role = remembered?.uid === firebaseUser.uid ? remembered.role : null;
    if (!['master', 'player'].includes(role)) {
      await logoutFirebaseAccount();
      showAuthGate();
      return;
    }
    if (role === 'master' && !(await isAuthorizedMaster(firebaseUser.uid))) {
      showMasterActivation(firebaseUser);
      return;
    }
    const profile = await getFirebaseProfile(firebaseUser.uid) || {
      displayName: firebaseUser.displayName || (firebaseUser.email || 'Usuário').split('@')[0],
      email: firebaseUser.email || '', createdAt: Date.now()
    };
    await completeFirebaseAccess(firebaseUser, profile, role, remembered?.sessionCode || null);
  } catch (error) {
    console.error(error);
    showAuthGate();
    showAuthError(`Não foi possível iniciar a conexão com o Firebase. ${authErrorMessage(error)}`);
  }
}
init();
