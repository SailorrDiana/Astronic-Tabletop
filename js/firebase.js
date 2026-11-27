import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  updateProfile
} from 'firebase/auth';
import {
  get,
  getDatabase,
  onValue,
  onDisconnect,
  push,
  ref,
  remove,
  runTransaction,
  set,
  update
} from 'firebase/database';

// Configuração do aplicativo Web Astronic Tabletop.
// A apiKey do SDK Web identifica o projeto; não é uma credencial administrativa.
// Nunca coloque chaves de conta de serviço ou credenciais Admin neste arquivo.
const firebaseConfig = {
  apiKey: 'AIzaSyDEuOVlsjoKYRCPMFU5cYQM4dYd0-DcwAg',
  authDomain: 'astronic-tabletop.firebaseapp.com',
  databaseURL: 'https://astronic-tabletop-default-rtdb.firebaseio.com',
  projectId: 'astronic-tabletop',
  storageBucket: 'astronic-tabletop.firebasestorage.app',
  messagingSenderId: '263283278325',
  appId: '1:263283278325:web:65133bec6df1ec8dee60bc'
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

const persistenceReady = setPersistence(auth, browserLocalPersistence);
const valueAt = async (path) => (await get(ref(db, path))).val();
const snapshotExists = (snapshot) => snapshot.exists();

export async function waitForAuthUser() {
  await persistenceReady;
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    }, (error) => {
      unsubscribe();
      reject(error);
    });
  });
}

export async function registerFirebaseAccount(email, password, displayName) {
  await persistenceReady;
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(credential.user, { displayName });
  const profile = {
    displayName,
    email: credential.user.email || email,
    createdAt: Date.now()
  };
  await set(ref(db, `userProfiles/${credential.user.uid}`), profile);
  return { user: credential.user, profile };
}

export async function loginFirebaseAccount(email, password) {
  await persistenceReady;
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const user = credential.user;
  let profile = await valueAt(`userProfiles/${user.uid}`);
  if (!profile) {
    profile = {
      displayName: user.displayName || (user.email || 'Jogador').split('@')[0],
      email: user.email || '',
      createdAt: Date.now()
    };
    await set(ref(db, `userProfiles/${user.uid}`), profile);
  } else if (user.displayName && profile.displayName !== user.displayName) {
    profile = { ...profile, displayName: user.displayName, email: user.email || profile.email };
    await set(ref(db, `userProfiles/${user.uid}`), profile);
  }
  return { user, profile };
}

export async function getFirebaseProfile(uid) {
  return valueAt(`userProfiles/${uid}`);
}

export async function isAuthorizedMaster(uid) {
  if (!uid) return false;
  return (await valueAt(`masterUsers/${uid}`)) === true;
}

export async function logoutFirebaseAccount() {
  await signOut(auth);
}

export function makeRemoteSessionCode() {
  // O alfabeto tem 32 caracteres; 8 bytes fornecem 40 bits de entropia.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join('');
}

export async function getMasterActiveSession(uid, campaignId) {
  const sessionId = await valueAt(`masterSessions/${uid}/${campaignId}`);
  if (!sessionId) return null;
  const info = await valueAt(`sessions/${sessionId}/info`);
  if (!info || info.status !== 'active') {
    await remove(ref(db, `masterSessions/${uid}/${campaignId}`));
    return null;
  }
  const participantData = await valueAt(`sessions/${sessionId}/participants`) || {};
  const participants = Object.values(participantData);
  return { id: sessionId, ...info, participants };
}

export async function getMasterSessionHistory(uid, campaignId) {
  const history = await valueAt(`masterSessionHistory/${uid}/${campaignId}`);
  return Object.entries(history || {}).map(([id, item]) => ({ id, ...item }))
    .sort((a, b) => (b.endedAt || b.createdAt || 0) - (a.endedAt || a.createdAt || 0));
}

export async function createFirebaseSession({ campaign, user }) {
  if (!user?.uid || !(await isAuthorizedMaster(user.uid))) {
    throw new Error('Esta conta ainda não foi autorizada como mestre no Firebase.');
  }
  const active = await getMasterActiveSession(user.uid, campaign.id);
  if (active) throw new Error('Esta campanha já possui uma sessão ativa.');

  const sessionId = push(ref(db, 'sessions')).key;
  if (!sessionId) throw new Error('Não foi possível gerar o identificador da sessão.');
  const now = Date.now();
  const info = {
    code: '',
    campaignId: campaign.id,
    campaignName: campaign.name,
    masterUid: user.uid,
    masterName: user.displayName || user.name || 'Mestre',
    status: 'creating',
    createdAt: now
  };

  let code = '';
  let codeClaimed = false;
  let pointerClaimed = false;
  try {
    await set(ref(db, `sessions/${sessionId}/info`), info);
    await set(ref(db, `sessions/${sessionId}/participants/${user.uid}`), {
      uid: user.uid,
      displayName: user.displayName || user.name || 'Mestre',
      role: 'master',
      joinedAt: now
    });

    for (let attempt = 0; attempt < 12; attempt += 1) {
      code = makeRemoteSessionCode();
      const claim = await runTransaction(ref(db, `sessionCodes/${code}`), (current) => {
        if (current === null) {
          return { sessionId, masterUid: user.uid, status: 'creating', createdAt: now };
        }
        return undefined;
      }, { applyLocally: false });
      if (claim.committed) {
        codeClaimed = true;
        break;
      }
    }
    if (!codeClaimed) throw new Error('Não foi possível gerar um código exclusivo. Tente novamente.');

    const pointerClaim = await runTransaction(ref(db, `masterSessions/${user.uid}/${campaign.id}`), (current) => current === null ? sessionId : undefined, { applyLocally: false });
    if (!pointerClaim.committed) throw new Error('Esta campanha já possui uma sessão ativa em outra janela. Atualize a central de sessões.');
    pointerClaimed = true;

    await update(ref(db, `sessions/${sessionId}/info`), { code, status: 'active' });
    await update(ref(db, `sessionCodes/${code}`), { status: 'active' });

    return {
      id: sessionId,
      ...info,
      code,
      status: 'active',
      participants: [{
        uid: user.uid,
        displayName: user.displayName || user.name || 'Mestre',
        role: 'master',
        joinedAt: now
      }]
    };
  } catch (error) {
    if (codeClaimed && code) await remove(ref(db, `sessionCodes/${code}`)).catch(() => {});
    await remove(ref(db, `sessions/${sessionId}/participants/${user.uid}`)).catch(() => {});
    await remove(ref(db, `sessions/${sessionId}/info`)).catch(() => {});
    if (pointerClaimed) await remove(ref(db, `masterSessions/${user.uid}/${campaign.id}`)).catch(() => {});
    throw error;
  }
}

export async function removeFirebaseRtcPlayerSignals(sessionId, playerUid) {
  if (!sessionId || !playerUid || !auth.currentUser?.uid) return;
  const info = await valueAt(`sessions/${sessionId}/info`);
  if (!info || info.masterUid !== auth.currentUser.uid || !(await isAuthorizedMaster(auth.currentUser.uid))) {
    throw new Error('Somente o mestre responsável pode limpar a sinalização desta sessão.');
  }
  await Promise.all([
    remove(ref(db, `sessions/${sessionId}/rtcOffers/${playerUid}`)),
    remove(ref(db, `sessions/${sessionId}/rtcAnswers/${playerUid}`)),
    remove(ref(db, `sessions/${sessionId}/rtcMasterCandidates/${playerUid}`)),
    remove(ref(db, `sessions/${sessionId}/rtcPlayerCandidates/${playerUid}`))
  ]);
}

export async function endFirebaseSession(session) {
  if (!session?.id || !auth.currentUser?.uid) throw new Error('Nenhuma sessão ativa foi encontrada.');
  const uid = auth.currentUser.uid;
  const info = await valueAt(`sessions/${session.id}/info`);
  if (!info || info.masterUid !== uid) throw new Error('Somente o mestre responsável pode encerrar esta sessão.');
  const participants = await valueAt(`sessions/${session.id}/participants`) || {};
  const endedAt = Date.now();
  await set(ref(db, `sessions/${session.id}/publishedState`), null);
  const playerUids = Object.values(participants).filter(item => item?.role === 'player' && item.uid).map(item => item.uid);
  await Promise.all(playerUids.map(playerUid => removeFirebaseRtcPlayerSignals(session.id, playerUid)));
  await update(ref(db, `sessions/${session.id}/info`), { status: 'ended', endedAt });
  if (info.code) {
    const codeInfo = await valueAt(`sessionCodes/${info.code}`);
    if (codeInfo?.sessionId === session.id) await remove(ref(db, `sessionCodes/${info.code}`));
  }
  const pointerPath = `masterSessions/${uid}/${info.campaignId}`;
  if ((await valueAt(pointerPath)) === session.id) await remove(ref(db, pointerPath));
  await set(ref(db, `masterSessionHistory/${uid}/${info.campaignId}/${session.id}`), {
    code: info.code || session.code || '',
    campaignName: info.campaignName || session.campaignName || '',
    createdAt: info.createdAt || session.createdAt || endedAt,
    endedAt,
    participantCount: Object.keys(participants).length
  });
}

export async function joinFirebaseSessionByCode(rawCode, user) {
  if (!user?.uid) throw new Error('Entre na sua conta antes de participar de uma sessão.');
  const code = String(rawCode || '').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 8);
  if (!code) throw new Error('Digite o código de convite.');

  // O código é a porta de entrada: primeiro localizamos a sessão pelo convite.
  // As regras do banco só permitem a leitura deste nó para usuários autenticados.
  const codeInfo = await valueAt(`sessionCodes/${code}`);
  if (!codeInfo || codeInfo.status !== 'active' || !codeInfo.sessionId) {
    throw new Error('Esse código não existe, expirou ou a sessão foi encerrada. Confira o convite com o mestre.');
  }
  if (codeInfo.masterUid === user.uid) {
    throw new Error('Você é o mestre desta sessão. Abra a Central do Mestre em vez de entrar como jogador.');
  }

  const participantPath = `sessions/${codeInfo.sessionId}/participants/${user.uid}`;
  const participantRef = ref(db, participantPath);
  const existingParticipant = await valueAt(participantPath);
  const joinedAt = Date.now();
  if (existingParticipant && existingParticipant.role !== 'player') {
    throw new Error('Esta conta não possui uma participação de jogador válida nesta sessão.');
  }
  // Atualizar joinedAt também invalida ofertas WebRTC antigas de uma entrada anterior.
  if (!existingParticipant) {
    await set(participantRef, {
      uid: user.uid,
      displayName: user.displayName || user.name || 'Jogador',
      role: 'player',
      joinedAt
    });
  } else {
    await update(participantRef, { displayName: user.displayName || user.name || 'Jogador', joinedAt });
  }

  // Registrar onDisconnect DEPOIS da presença existir: a regra de remoção
  // confere que o registro atual pertence a um jogador.
  const disconnectPresence = onDisconnect(participantRef);
  try {
    await disconnectPresence.remove();
  } catch (error) {
    if (!existingParticipant) await remove(participantRef).catch(() => {});
    throw error;
  }

  // A leitura dos detalhes da sessão agora exige que o usuário já seja
  // participante, em vez de permitir a leitura de qualquer sessão ativa.
  const info = await valueAt(`sessions/${codeInfo.sessionId}/info`);
  if (!info || info.status !== 'active' || info.masterUid !== codeInfo.masterUid) {
    await disconnectPresence.cancel().catch(() => {});
    await remove(participantRef).catch(() => {});
    throw new Error('Essa sessão não está mais aberta para participantes.');
  }

  const participants = await valueAt(`sessions/${codeInfo.sessionId}/participants`) || {};
  return {
    id: codeInfo.sessionId,
    ...info,
    participants: Object.values(participants),
    joinedAt,
    isOnline: true
  };
}

export async function leaveFirebaseSession(sessionId, uid) {
  if (!sessionId || !uid) return;
  const participantPath = `sessions/${sessionId}/participants/${uid}`;
  const participantRef = ref(db, participantPath);
  const participant = await valueAt(participantPath);
  if (participant?.role === 'player') {
    await onDisconnect(participantRef).cancel().catch(() => {});
    await remove(participantRef);
  }
}

export function watchFirebaseParticipants(sessionId, callback, onError = () => {}) {
  return onValue(ref(db, `sessions/${sessionId}/participants`), (snapshot) => {
    callback(Object.values(snapshot.val() || {}));
  }, onError);
}

export function watchFirebaseSessionInfo(sessionId, callback, onError = () => {}) {
  return onValue(ref(db, `sessions/${sessionId}/info`), (snapshot) => {
    callback(snapshot.val());
  }, onError);
}

export function watchFirebasePublishedState(sessionId, callback, onError = () => {}) {
  return onValue(ref(db, `sessions/${sessionId}/publishedState`), (snapshot) => {
    callback(snapshot.val());
  }, onError);
}

// Estado publicado: somente o mestre responsável pode alterar o que os jogadores veem.
export async function publishFirebaseState(sessionId, publishedState) {
  if (!sessionId || !auth.currentUser?.uid) throw new Error('Entre na conta do mestre antes de apresentar um mapa.');
  const uid = auth.currentUser.uid;
  const info = await valueAt(`sessions/${sessionId}/info`);
  if (!info || info.status !== 'active' || info.masterUid !== uid || !(await isAuthorizedMaster(uid))) {
    throw new Error('Somente o mestre responsável pode publicar conteúdo nesta sessão ativa.');
  }
  await set(ref(db, `sessions/${sessionId}/publishedState`), publishedState || null);
}

// Sinalização WebRTC: os dados binários trafegam no canal ponto a ponto;
// o Realtime Database guarda apenas ofertas, respostas e candidatos ICE.
export function watchFirebaseRtcOffers(sessionId, playerUid, callback, onError = () => {}) {
  return onValue(ref(db, `sessions/${sessionId}/rtcOffers/${playerUid}`), snapshot => callback(snapshot.val() || {}), onError);
}

export async function writeFirebaseRtcOffer(sessionId, playerUid, connectionId, offer) {
  await set(ref(db, `sessions/${sessionId}/rtcOffers/${playerUid}/${connectionId}`), offer);
}

export function watchFirebaseRtcAnswer(sessionId, playerUid, connectionId, callback, onError = () => {}) {
  return onValue(ref(db, `sessions/${sessionId}/rtcAnswers/${playerUid}/${connectionId}`), snapshot => callback(snapshot.val()), onError);
}

export async function writeFirebaseRtcAnswer(sessionId, playerUid, connectionId, answer) {
  await set(ref(db, `sessions/${sessionId}/rtcAnswers/${playerUid}/${connectionId}`), answer);
}

function rtcCandidatesPath(sessionId, direction, playerUid, connectionId) {
  const node = direction === 'master' ? 'rtcMasterCandidates' : 'rtcPlayerCandidates';
  return `sessions/${sessionId}/${node}/${playerUid}/${connectionId}`;
}

export async function addFirebaseRtcCandidate(sessionId, direction, playerUid, connectionId, candidate) {
  await push(ref(db, rtcCandidatesPath(sessionId, direction, playerUid, connectionId)), candidate);
}

export function watchFirebaseRtcCandidates(sessionId, direction, playerUid, connectionId, callback, onError = () => {}) {
  return onValue(ref(db, rtcCandidatesPath(sessionId, direction, playerUid, connectionId)), snapshot => callback(snapshot.val() || {}), onError);
}
