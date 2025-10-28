// scripts.js
// Full client-side logic for CozyBoard features:
// - Firestore-backed topics with keywords, views, favorites
// - Double-tap to favorite (per-device) stored in Firestore
// - View-count per device (topics/{topicId}/views/{deviceId})
// - Threaded comments: topics/{topicId}/comments/{commentId}/replies/{replyId}
// - Real-time updates via onSnapshot
// - Local device id, local username storage, simple offline comment queue
// - Smooth UI interactions: opening modals, rendering, reply flows
//
// This file expects firebase compat SDKs to be loaded (firebase-app-compat.js & firebase-firestore-compat.js).
// It pairs with an HTML file that has the DOM IDs used below (topicsContainer, addTopicModal, viewTopicModal, etc).
//
// CONFIG: replace with your firebaseConfig (or use provided config)
const firebaseConfig = {
  apiKey: "AIzaSyAuVJXLvCofXSd66MUnGAi1KwACSKKenGQ",
  authDomain: "bigone-e9b19.firebaseapp.com",
  projectId: "bigone-e9b19",
  storageBucket: "bigone-e9b19.firebasestorage.app",
  messagingSenderId: "850687656754",
  appId: "1:850687656754:web:4365b3fcfd253794f3cd2b"
};

// Initialize Firebase (compat)
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();

// Enable persistence if available
db.enablePersistence && db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  console.info('IndexedDB persistence not available:', err && err.code ? err.code : err);
});

/* -------------------------
   DOM Refs
--------------------------*/
const topicsContainer = document.getElementById('topicsContainer');
const addTopicBtn = document.getElementById('addTopicBtn');
const addTopicModal = document.getElementById('addTopicModal');
const saveTopicBtn = document.getElementById('saveTopicBtn'); // assumed id in your HTML; if different, adapt
const closeModalButtons = Array.from(document.querySelectorAll('.closeModal'));
const searchInput = document.getElementById('searchInput');

// View modal elements
const viewModal = document.getElementById('viewTopicModal');
const modalTitleEl = document.getElementById('modalTitle');
const modalBodyEl = document.getElementById('modalBody');
const modalKeywordsEl = document.getElementById('modalKeywords');
const commentsContainer = document.getElementById('commentsContainer');
const addCommentBtn = document.getElementById('addCommentBtn');
const userNameInput = document.getElementById('userName');
const commentTextInput = document.getElementById('commentText');

// Add-topic inputs
const topicTitleInput = document.getElementById('topicTitle');
const topicBodyInput = document.getElementById('topicBody');
const topicKeywordsInput = document.getElementById('topicKeywords');

/* -------------------------
   Device & local utilities
--------------------------*/
const DEVICE_KEY = 'cozy_device_id';
function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = 'd_' + Math.random().toString(36).slice(2, 12);
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}
const deviceId = getDeviceId();

const NAME_KEY = 'cozy_username';
function loadLocalName() {
  const n = localStorage.getItem(NAME_KEY) || '';
  if (userNameInput) userNameInput.value = n;
}
function setLocalName(v) { localStorage.setItem(NAME_KEY, v || ''); }

/* -------------------------
   Offline comment queue (simple)
--------------------------*/
const COMMENT_QUEUE_KEY = 'cozy_comment_queue_v1';
function enqueueComment(item) {
  const q = JSON.parse(localStorage.getItem(COMMENT_QUEUE_KEY) || '[]');
  q.push(item);
  localStorage.setItem(COMMENT_QUEUE_KEY, JSON.stringify(q));
}
async function flushCommentQueue() {
  const raw = localStorage.getItem(COMMENT_QUEUE_KEY);
  if (!raw) return;
  let q = JSON.parse(raw || '[]');
  if (!q.length) return;
  const successes = [];
  for (const it of q) {
    try {
      await db.collection('topics').doc(it.topicId).collection('comments').add({
        userName: it.userName,
        text: it.text,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      successes.push(it);
    } catch (e) {
      console.warn('Failed flushing comment', e);
    }
  }
  if (successes.length) {
    q = q.filter(x => !successes.includes(x));
    localStorage.setItem(COMMENT_QUEUE_KEY, JSON.stringify(q));
    showToast(`Sent ${successes.length} pending comment(s)`);
  }
}
window.addEventListener('online', () => { flushCommentQueue().catch(()=>{}); });

/* -------------------------
   Small UI helpers
--------------------------*/
function show(el) { if (!el) return; el.classList.remove('hidden'); }
function hide(el) { if (!el) return; el.classList.add('hidden'); }
function $(sel) { return document.querySelector(sel); }

function showToast(msg, ms = 2200) {
  // create a simple toast if none exists
  let t = document.getElementById('cozy_toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'cozy_toast';
    t.style.position = 'fixed';
    t.style.left = '50%';
    t.style.transform = 'translateX(-50%)';
    t.style.bottom = '26px';
    t.style.padding = '10px 14px';
    t.style.borderRadius = '10px';
    t.style.background = 'linear-gradient(180deg,#efeaff,#f7f3ff)';
    t.style.boxShadow = '0 8px 30px rgba(90,70,120,0.12)';
    t.style.zIndex = '9999';
    t.style.color = '#3b2f3f';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  t.style.display = 'block';
  setTimeout(() => { if (t) t.style.opacity = '0'; setTimeout(()=> t.style.display='none', 400); }, ms);
}

/* -------------------------
   Pastel mood palette & helper
--------------------------*/
const PASTEL_PALETTES = [
  ['#FFD6E8','#FFF3F8'], // pink
  ['#E8DAFF','#F8F5FF'], // lavender
  ['#DFF7F0','#F4FFF9'], // mint
  ['#FFF7D6','#FFFBF0'], // butter
  ['#DFF0FF','#F6FCFF'], // sky
  ['#FFE6F7','#FFF5FB']  // cotton candy
];

function pickPaletteFromId(id) {
  if (!id) return PASTEL_PALETTES[0];
  let h = 0;
  for (let i=0;i<id.length;i++){ h = (h*31 + id.charCodeAt(i)) % 1000; }
  return PASTEL_PALETTES[h % PASTEL_PALETTES.length];
}

/* -------------------------
   Live topics listener & rendering
--------------------------*/
let topicsUnsub = null;
let topicsCache = []; // mirror cached topics for client-side filtering

function startTopicsListener() {
  // We attempt to order by favoritesCount desc, views desc, createdAt desc.
  // If Firestore requires an index and rejects, fallback to ordering by createdAt and sort client-side.
  const topicsRef = db.collection('topics');
  const q = topicsRef.orderBy('favoritesCount', 'desc').orderBy('views', 'desc').orderBy('createdAt', 'desc');

  topicsUnsub = q.onSnapshot(async (snapshot) => {
    const arr = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      arr.push({
        id: doc.id,
        title: d.title || '',
        body: d.body || '',
        keywords: d.keywords || [],
        createdAt: d.createdAt || null,
        views: d.views || 0,
        favoritesCount: d.favoritesCount || 0
      });
    });
    topicsCache = arr;
    renderTopics(arr);
  }, (err) => {
    console.warn('Primary topics query failed (likely missing composite index). Falling back to createdAt ordering.', err);
    // fallback: listen ordered by createdAt and sort client-side
    if (topicsUnsub) topicsUnsub(); // unsubscribe previous
    const fallbackQ = topicsRef.orderBy('createdAt','desc');
    topicsUnsub = fallbackQ.onSnapshot((snapshot) => {
      const arr = [];
      snapshot.forEach(doc => {
        const d = doc.data();
        arr.push({
          id: doc.id,
          title: d.title || '',
          body: d.body || '',
          keywords: d.keywords || [],
          createdAt: d.createdAt || null,
          views: d.views || 0,
          favoritesCount: d.favoritesCount || 0
        });
      });
      // sort in-memory: favorites desc, views desc, createdAt desc
      arr.sort((a,b) => {
        if ((b.favoritesCount || 0) !== (a.favoritesCount || 0)) return (b.favoritesCount || 0) - (a.favoritesCount || 0);
        if ((b.views || 0) !== (a.views || 0)) return (b.views || 0) - (a.views || 0);
        const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
        const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
        return tb - ta;
      });
      topicsCache = arr;
      renderTopics(arr);
    }, (err2) => {
      console.error('Fallback topics listener failed:', err2);
      topicsContainer.innerHTML = `<div class="muted">Failed to load topics.</div>`;
    });
  });
}

function renderTopics(list) {
  const q = (searchInput && searchInput.value || '').trim().toLowerCase();
  const filtered = list.filter(t => {
    if (!q) return true;
    return (t.title || '').toLowerCase().includes(q) ||
           (t.body || '').toLowerCase().includes(q) ||
           (t.keywords || []).join(' ').toLowerCase().includes(q);
  });

  topicsContainer.innerHTML = '';
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = 'No topics yet — create one!';
    topicsContainer.appendChild(empty);
    return;
  }

  filtered.forEach(topic => {
    const card = document.createElement('div');
    card.className = 'topic-card';
    // pick a palette and create subtle gradient
    const pal = pickPaletteFromId(topic.id);
    card.style.background = `linear-gradient(135deg, ${pal[0]} 0%, ${pal[1]} 100%)`;
    card.style.borderRadius = '14px';
    card.style.padding = '14px';
    card.style.position = 'relative';
    card.style.cursor = 'pointer';
    card.style.transition = 'transform .12s ease, box-shadow .12s ease';

    // structure: title, keywords, createdAt, viewCount bottom-right, favorites small badge top-right
    const titleEl = document.createElement('h3');
    titleEl.textContent = topic.title;
    titleEl.style.margin = '0';
    titleEl.style.fontSize = '1.05rem';
    titleEl.style.fontWeight = '600';
    titleEl.style.color = '#37203a';
    titleEl.style.userSelect = 'none';

    // keywords inline
    const keywordsWrap = document.createElement('div');
    keywordsWrap.className = 'keywords-inline';
    keywordsWrap.style.marginTop = '8px';
    (topic.keywords || []).slice(0,6).forEach(k => {
      const kEl = document.createElement('span');
      kEl.className = 'keyword-badge';
      kEl.textContent = k;
      kEl.style.display = 'inline-block';
      kEl.style.padding = '4px 8px';
      kEl.style.marginRight = '6px';
      kEl.style.fontSize = '0.78rem';
      kEl.style.borderRadius = '999px';
      kEl.style.background = 'rgba(255,255,255,0.7)';
      kEl.style.color = '#4a3b55';
      keywordsWrap.appendChild(kEl);
    });

    const metaWrap = document.createElement('div');
    metaWrap.style.display = 'flex';
    metaWrap.style.justifyContent = 'space-between';
    metaWrap.style.alignItems = 'center';
    metaWrap.style.marginTop = '10px';

    const timeEl = document.createElement('div');
    timeEl.className = 'meta-time';
    timeEl.textContent = formatTimestamp(topic.createdAt);
    timeEl.style.color = '#6e5e6f';
    timeEl.style.fontSize = '0.88rem';

    const rightMeta = document.createElement('div');
    rightMeta.style.display = 'flex';
    rightMeta.style.alignItems = 'center';
    rightMeta.style.gap = '10px';

    // favorites count small badge
    const favBadge = document.createElement('div');
    favBadge.className = 'fav-badge';
    favBadge.textContent = `${topic.favoritesCount || 0}★`;
    favBadge.title = 'Favorites (double-tap the card to toggle favorite)';
    favBadge.style.fontSize = '0.88rem';
    favBadge.style.color = '#5a3f5a';
    favBadge.style.background = 'rgba(255,255,255,0.75)';
    favBadge.style.padding = '6px 8px';
    favBadge.style.borderRadius = '10px';

    // view count bottom-right (but rendered here as small meta)
    const viewBadge = document.createElement('div');
    viewBadge.className = 'view-badge';
    viewBadge.textContent = `${topic.views || 0} views`;
    viewBadge.style.fontSize = '0.85rem';
    viewBadge.style.color = '#5a3f5a';

    rightMeta.appendChild(favBadge);
    rightMeta.appendChild(viewBadge);

    metaWrap.appendChild(timeEl);
    metaWrap.appendChild(rightMeta);

    // append things to card
    card.appendChild(titleEl);
    card.appendChild(keywordsWrap);
    card.appendChild(metaWrap);

    // interactions:
    // single-click opens modal
    card.addEventListener('click', (e) => {
      // ignore if clicking on inner interactive element
      openTopicModal(topic.id);
    });

    // double-tap / dblclick -> toggle favorite
    addDoubleTapFavorite(card, topic.id);

    // keyboard accessibility
    card.tabIndex = 0;
    card.addEventListener('keypress', (ev) => { if (ev.key === 'Enter') openTopicModal(topic.id); });

    // small hover style
    card.addEventListener('mouseenter', () => { card.style.transform = 'translateY(-4px)'; card.style.boxShadow = '0 12px 40px rgba(120,90,150,0.06)'; });
    card.addEventListener('mouseleave', () => { card.style.transform = 'translateY(0)'; card.style.boxShadow = ''; });

    topicsContainer.appendChild(card);
  });
}

/* Helper: add double-tap (touch) and dblclick (desktop) to toggle favorite */
function addDoubleTapFavorite(el, topicId) {
  let lastTap = 0;
  el.addEventListener('touchend', async (e) => {
    const now = Date.now();
    const delta = now - lastTap;
    if (delta < 300 && delta > 0) {
      e.preventDefault();
      await toggleFavorite(topicId);
    }
    lastTap = now;
  }, { passive: true });

  el.addEventListener('dblclick', async (e) => {
    e.preventDefault();
    await toggleFavorite(topicId);
  });
}

/* -------------------------
   Topic modal: open, viewcount increment, comments subscription
--------------------------*/
let commentsUnsub = null;
let currentOpenTopicId = null;

async function openTopicModal(topicId) {
  currentOpenTopicId = topicId;
  // increment view for this device (one per device)
  try {
    await ensureViewIncrement(topicId);
  } catch (err) {
    console.warn('View increment failed', err);
  }

  // get doc and populate modal
  const doc = await db.collection('topics').doc(topicId).get();
  if (!doc.exists) { showToast('Topic not found'); return; }
  const data = doc.data();
  modalTitleEl.textContent = data.title || '';
  modalBodyEl.textContent = data.body || '';
  modalKeywordsEl.innerHTML = '';
  (data.keywords || []).forEach(k => {
    const span = document.createElement('span');
    span.className = 'keyword';
    span.textContent = k;
    span.style.marginRight = '6px';
    span.style.padding = '4px 8px';
    span.style.borderRadius = '999px';
    span.style.fontSize = '0.82rem';
    span.style.background = 'rgba(255,255,255,0.6)';
    span.style.color = '#4a3b55';
    modalKeywordsEl.appendChild(span);
  });

  // apply mood palette to modal background for consistent look
  const pal = pickPaletteFromId(topicId);
  const modalContent = viewModal.querySelector('.modal-content');
  if (modalContent) {
    modalContent.style.background = `linear-gradient(90deg, ${pal[0]} 0%, ${pal[1]} 100%)`;
    modalContent.style.boxShadow = '0 18px 60px rgba(70,40,120,0.12)';
  }

  show(viewModal);

  // subscribe to comments of this topic (realtime)
  if (typeof commentsUnsub === 'function') { commentsUnsub(); commentsUnsub = null; }
  const commentsRef = db.collection('topics').doc(topicId).collection('comments').orderBy('createdAt','asc');
  commentsUnsub = commentsRef.onSnapshot((snap) => {
    const arr = [];
    snap.forEach(s => { arr.push({ id: s.id, ...s.data() }); });
    renderCommentsThread(topicId, arr);
  }, (err) => {
    console.warn('Comments listener error', err);
    commentsContainer.innerHTML = `<div class="muted small">Failed to load comments.</div>`;
  });

  // set local name into input
  loadLocalName();
}

/* Ensure view increment: checks topics/{topicId}/views/{deviceId} doc; if not exists, create and increment topic.views atomically */
async function ensureViewIncrement(topicId) {
  const viewDocRef = db.collection('topics').doc(topicId).collection('views').doc(deviceId);
  const docSnap = await viewDocRef.get();
  if (docSnap.exists) return; // already counted for this device
  // create a view doc and increment counter in a transaction
  try {
    await db.runTransaction(async (tx) => {
      tx.set(viewDocRef, { viewedAt: firebase.firestore.FieldValue.serverTimestamp(), deviceId });
      const topicRef = db.collection('topics').doc(topicId);
      const topicSnap = await tx.get(topicRef);
      const current = (topicSnap.exists && topicSnap.data().views) ? topicSnap.data().views : 0;
      tx.update(topicRef, { views: (current + 1) });
    });
  } catch (err) {
    // if transaction fails, fallback to best-effort increment
    console.warn('Transaction view increment failed, trying best-effort update', err);
    try {
      const topicRef = db.collection('topics').doc(topicId);
      await topicRef.update({ views: firebase.firestore.FieldValue.increment(1) });
      await viewDocRef.set({ viewedAt: firebase.firestore.FieldValue.serverTimestamp(), deviceId });
    } catch (e) {
      console.warn('Fallback view increment failed', e);
    }
  }
}

/* -------------------------
   Render threaded comments (comments + replies)
   Structure:
     - top-level comments: topics/{topicId}/comments/{commentId}
     - replies: topics/{topicId}/comments/{commentId}/replies/{replyId}
--------------------------*/
function renderCommentsThread(topicId, commentsArray) {
  commentsContainer.innerHTML = '';
  if (!commentsArray.length) {
    const none = document.createElement('div');
    none.className = 'muted';
    none.textContent = 'No comments yet — be the first!';
    commentsContainer.appendChild(none);
    return;
  }
  // For each top-level comment, render and then its replies (subscribe to replies)
  commentsArray.forEach(c => {
    const topDiv = document.createElement('div');
    topDiv.className = 'comment';
    topDiv.style.background = '#ffffff';
    topDiv.style.borderLeft = '3px solid rgba(200,160,220,0.18)';
    topDiv.style.padding = '10px';
    topDiv.style.marginTop = '10px';
    topDiv.style.borderRadius = '10px';

    const meta = document.createElement('div');
    meta.style.display = 'flex';
    meta.style.justifyContent = 'space-between';
    meta.style.alignItems = 'center';
    meta.style.marginBottom = '6px';

    const who = document.createElement('div');
    who.textContent = c.userName || 'Anonymous';
    who.style.fontWeight = '700';
    who.style.color = '#6b3f6b';

    const when = document.createElement('div');
    when.textContent = formatTimestamp(c.createdAt);
    when.style.color = '#7b6f84';
    when.style.fontSize = '0.85rem';

    meta.appendChild(who);
    meta.appendChild(when);

    const body = document.createElement('div');
    body.textContent = c.text || '';
    body.style.marginBottom = '8px';
    body.style.color = '#3b2f3f';

    // reply button (shows a small reply composer)
    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    const replyBtn = document.createElement('button');
    replyBtn.textContent = 'Reply';
    replyBtn.style.padding = '6px 10px';
    replyBtn.style.borderRadius = '8px';
    replyBtn.style.border = 'none';
    replyBtn.style.background = '#e8daff';
    replyBtn.style.cursor = 'pointer';
    replyBtn.style.fontWeight = '600';

    actions.appendChild(replyBtn);

    // replies container
    const repliesContainer = document.createElement('div');
    repliesContainer.style.marginTop = '8px';
    repliesContainer.className = 'replies-container';

    topDiv.appendChild(meta);
    topDiv.appendChild(body);
    topDiv.appendChild(actions);
    topDiv.appendChild(repliesContainer);

    // append to top-level comments container
    commentsContainer.appendChild(topDiv);

    // load replies for this comment (realtime)
    const repliesRef = db.collection('topics').doc(topicId).collection('comments').doc(c.id).collection('replies').orderBy('createdAt','asc');
    const unsubReplies = repliesRef.onSnapshot((snap) => {
      repliesContainer.innerHTML = '';
      snap.forEach(rdoc => {
        const r = rdoc.data();
        const rEl = document.createElement('div');
        rEl.className = 'comment reply';
        rEl.style.background = '#fff7ff';
        rEl.style.padding = '8px';
        rEl.style.marginTop = '8px';
        rEl.style.borderRadius = '10px';
        rEl.innerHTML = `<div style="font-weight:700;color:#5a3f5a">${escapeHtml(r.userName || 'Anonymous')}</div>
                         <div style="color:#3b2f3f">${escapeHtml(r.text || '')}</div>
                         <div style="color:#7b6f84;font-size:0.82rem;margin-top:6px">${formatTimestamp(r.createdAt)}</div>`;
        repliesContainer.appendChild(rEl);
      });
    }, (err) => {
      console.warn('Replies listener failed', err);
    });

    // reply button interaction: open an inline composer
    replyBtn.addEventListener('click', () => {
      // prevent multiple reply boxes
      if (topDiv.querySelector('.inline-reply')) return;
      const inline = document.createElement('div');
      inline.className = 'inline-reply';
      inline.style.marginTop = '8px';
      inline.innerHTML = `
        <input class="inline-reply-name" placeholder="Your name" style="width:40%; padding:8px; border-radius:8px; border:1px solid rgba(150,120,160,0.08); margin-right:8px" />
        <input class="inline-reply-text" placeholder="Write a reply..." style="width:50%; padding:8px; border-radius:8px; border:1px solid rgba(150,120,160,0.08)" />
        <button class="inline-reply-send" style="padding:8px 10px; margin-left:8px; border-radius:8px; border:none; background:#cbb1ff; color:#382545; font-weight:600">Send</button>
      `;
      topDiv.appendChild(inline);
      const send = inline.querySelector('.inline-reply-send');
      send.addEventListener('click', async () => {
        const name = inline.querySelector('.inline-reply-name').value.trim() || (localStorage.getItem(NAME_KEY) || 'Anonymous');
        const text = inline.querySelector('.inline-reply-text').value.trim();
        if (!text) { showToast('Write a reply first'); return; }
        try {
          await db.collection('topics').doc(topicId).collection('comments').doc(c.id).collection('replies').add({
            userName: name,
            text,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
          // optionally persist name
          localStorage.setItem(NAME_KEY, name);
          inline.remove();
        } catch (err) {
          console.warn('Reply failed, queueing locally', err);
          enqueueComment({ topicId, userName: name, text }); // reuse comment queue as last-resort
          inline.remove();
          showToast('Reply queued (offline)');
        }
      });
    });

    // cleanup: when modal closes, unsubReplies should be detached; we store unsub functions to call later
    topDiv._unsubReplies = unsubReplies;
  });

  // When comments rerender, we don't keep track of unsubscribed listeners globally here,
  // but they are attached to each top-level comment and will be garbage-collected when removed.
}

/* -------------------------
   Comment submission (top-level)
--------------------------*/
addCommentBtn && addCommentBtn.addEventListener('click', async () => {
  const name = (userNameInput && userNameInput.value.trim()) || (localStorage.getItem(NAME_KEY) || 'Anonymous');
  const text = (commentTextInput && commentTextInput.value.trim());
  if (!text) { showToast('Please write a comment'); return; }
  if (!currentOpenTopicId) { showToast('No topic open'); return; }
  setLocalName(name);
  const commentObj = {
    userName: name,
    text,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  try {
    if (!navigator.onLine) {
      // offline: queue local
      enqueueComment({ topicId: currentOpenTopicId, userName: name, text });
      commentTextInput.value = '';
      showToast('Offline — comment queued');
      return;
    }
    await db.collection('topics').doc(currentOpenTopicId).collection('comments').add(commentObj);
    commentTextInput.value = '';
  } catch (err) {
    console.warn('Add comment failed, queuing', err);
    enqueueComment({ topicId: currentOpenTopicId, userName: name, text });
    commentTextInput.value = '';
    showToast('Comment queued (will send when online)');
  }
});

/* -------------------------
   Favorites toggle (per-device) using topics/{topicId}/favorites/{deviceId}
   Also updates topics.{favoritesCount} via transaction for consistency.
--------------------------*/
async function toggleFavorite(topicId) {
  const favDocRef = db.collection('topics').doc(topicId).collection('favorites').doc(deviceId);
  const topicRef = db.collection('topics').doc(topicId);
  try {
    await db.runTransaction(async (tx) => {
      const favSnap = await tx.get(favDocRef);
      const topicSnap = await tx.get(topicRef);
      let currentCount = (topicSnap.exists && topicSnap.data().favoritesCount) ? topicSnap.data().favoritesCount : 0;
      if (favSnap.exists) {
        // remove favorite
        tx.delete(favDocRef);
        currentCount = Math.max(0, currentCount - 1);
        tx.update(topicRef, { favoritesCount: currentCount });
      } else {
        // add favorite
        tx.set(favDocRef, { deviceId, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
        currentCount = currentCount + 1;
        tx.update(topicRef, { favoritesCount: currentCount });
      }
    });
    showToast('Favorited toggled');
  } catch (err) {
    console.error('toggleFavorite failed', err);
    showToast('Could not toggle favorite');
  }
}

/* -------------------------
   Toggle favorite exposed for double-tap
--------------------------*/
async function toggleFavoriteInstant(topicId) {
  await toggleFavorite(topicId).catch(() => {});
}

/* -------------------------
   Topic creation logic
--------------------------*/
if (addTopicBtn) {
  addTopicBtn.addEventListener('click', () => {
    if (addTopicModal) show(addTopicModal);
    if (topicTitleInput) topicTitleInput.focus();
  });
}
if (closeModalButtons && closeModalButtons.length) {
  closeModalButtons.forEach(btn => btn.addEventListener('click', (e) => {
    const modal = e.currentTarget.closest('.modal');
    if (modal) hide(modal);
  }));
}
if (saveTopicBtn) {
  saveTopicBtn.addEventListener('click', async () => {
    const title = (topicTitleInput && topicTitleInput.value.trim()) || '';
    const body = (topicBodyInput && topicBodyInput.value.trim()) || '';
    const keywords = (topicKeywordsInput && topicKeywordsInput.value.trim()) ? topicKeywordsInput.value.split(',').map(s=>s.trim()).filter(Boolean) : [];
    if (!title || !body) { showToast('Please add a title and body'); return; }
    const topicDoc = {
      title,
      body,
      keywords,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      views: 0,
      favoritesCount: 0
    };
    try {
      await db.collection('topics').add(topicDoc);
      showToast('Topic saved');
      if (addTopicModal) hide(addTopicModal);
      if (topicTitleInput) topicTitleInput.value = '';
      if (topicBodyInput) topicBodyInput.value = '';
      if (topicKeywordsInput) topicKeywordsInput.value = '';
    } catch (err) {
      console.error('Failed to save topic', err);
      showToast('Failed to save topic');
    }
  });
}

/* -------------------------
   Search filter
--------------------------*/
if (searchInput) {
  searchInput.addEventListener('input', () => {
    renderTopics(topicsCache);
  });
}

/* -------------------------
   Utilities: format timestamp, escapeHtml
--------------------------*/
function formatTimestamp(ts) {
  if (!ts) return '';
  try {
    if (ts.toDate) return ts.toDate().toLocaleString();
    if (ts.seconds) return new Date(ts.seconds * 1000).toLocaleString();
    return new Date(ts).toLocaleString();
  } catch (e) {
    return '';
  }
}
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
}

/* -------------------------
   Admin helper: wipe all topics and subcollections
   WARNING: This is destructive and must be run manually from console:
     await wipeAllTopics()
--------------------------*/
window.wipeAllTopics = async function wipeAllTopics() {
  if (!confirm('Delete ALL topics and their subcollections? This is irreversible. Continue?')) return;
  try {
    const snap = await db.collection('topics').get();
    for (let doc of snap.docs) {
      const id = doc.id;
      // delete comments subcollections
      const commentsSnap = await db.collection('topics').doc(id).collection('comments').get();
      for (const c of commentsSnap.docs) {
        // delete replies under each comment
        const repliesSnap = await db.collection('topics').doc(id).collection('comments').doc(c.id).collection('replies').get();
        const batchR = db.batch();
        repliesSnap.docs.forEach(rdoc => batchR.delete(rdoc.ref));
        await batchR.commit();
        // delete comment doc
        await db.collection('topics').doc(id).collection('comments').doc(c.id).delete();
      }
      // delete favorites subcollection
      const favSnap = await db.collection('topics').doc(id).collection('favorites').get();
      const batchF = db.batch();
      favSnap.docs.forEach(f => batchF.delete(f.ref));
      await batchF.commit();
      // delete views subcollection
      const viewsSnap = await db.collection('topics').doc(id).collection('views').get();
      const batchV = db.batch();
      viewsSnap.docs.forEach(v => batchV.delete(v.ref));
      await batchV.commit();

      // finally delete topic
      await db.collection('topics').doc(id).delete();
      console.log('Deleted topic', id);
    }
    showToast('All topics deleted');
  } catch (err) {
    console.error('wipeAllTopics failed', err);
    showToast('Failed to wipe topics (see console)');
  }
};

/* -------------------------
   Start
--------------------------*/
(function init() {
  loadLocalName();
  startTopicsListener();
  // close modal on background click
  document.addEventListener('click', (e) => {
    if (e.target.classList && e.target.classList.contains('modal')) {
      hide(e.target);
    }
  });
  // allow Esc key to close modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hide(addTopicModal);
      hide(viewModal);
    }
  });
  // attempt flush queued comments on load if online
  if (navigator.onLine) flushCommentQueue().catch(()=>{});
})();
