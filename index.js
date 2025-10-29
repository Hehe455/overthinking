// ================================
// Lots of Yapping - index.js (Final Full Version, Fixed)
// ================================

document.addEventListener("DOMContentLoaded", () => {
  // ================================
  // Firebase Initialization
  // ================================
  const firebaseConfig = {
    apiKey: "AIzaSyAuVJXLvCofXSd66MUnGAi1KwACSKKenGQ",
    authDomain: "bigone-e9b19.firebaseapp.com",
    projectId: "bigone-e9b19",
    storageBucket: "bigone-e9b19.firebasestorage.app",
    messagingSenderId: "850687656754",
    appId: "1:850687656754:web:4365b3fcfd253794f3cd2b",
  };

  firebase.initializeApp(firebaseConfig);
  const db = firebase.firestore();

  // Optional: enable persistence safely
  firebase.firestore().enablePersistence({ synchronizeTabs: true }).catch(() => {});

  // ================================
  // DOM Elements
  // ================================
  const topicListEl = document.getElementById("topicList");
  const addTopicBtn = document.getElementById("addTopicBtn");
  const addTopicModal = document.getElementById("addTopicModal");
  const closeAddTopic = document.getElementById("closeAddTopic");
  const saveTopicBtn = document.getElementById("saveTopicBtn");
  const topicTitleInput = document.getElementById("topicTitle");
  const topicBodyInput = document.getElementById("topicBody");
  const topicKeywordsInput = document.getElementById("topicKeywords");

  const topicModal = document.getElementById("topicModal");
  const closeTopicModal = document.getElementById("closeTopicModal");
  const modalTopicTitle = document.getElementById("modalTopicTitle");
  const modalTopicBody = document.getElementById("modalTopicBody");
  const modalTopicMeta = document.getElementById("modalTopicMeta");
  const searchInput = document.getElementById("searchInput");

  const commentForm = document.getElementById("commentForm");
  const commentInput = document.getElementById("commentInput");
  const commentList = document.getElementById("commentList");
  const quoteBtn = document.getElementById("quoteBtn");
  const referenceModal = document.getElementById("referenceModal");
  const referenceBody = document.getElementById("referenceBody");
  const cancelReference = document.getElementById("cancelReference");
  const confirmReference = document.getElementById("confirmReference");
  const referencePreview = document.getElementById("referencePreview");
  const toastContainer = document.getElementById("toastContainer");

  // ================================
  // Local Device / User Tracking
  // ================================
  const deviceId = localStorage.getItem("deviceId") || crypto.randomUUID();
  localStorage.setItem("deviceId", deviceId);

  const username =
    localStorage.getItem("username") ||
    prompt("Enter your name (for comments):") ||
    "Anonymous";
  localStorage.setItem("username", username);

  let allTopics = [];
  let unreadTopics = new Set(JSON.parse(localStorage.getItem("unreadTopics") || "[]"));
  let favoriteTopics = new Set(JSON.parse(localStorage.getItem("favoriteTopics") || "[]"));
  let selectedTopicId = null;
  let selectedReferenceText = "";

  // ================================
  // Helper Functions
  // ================================
  function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  function openModal(modal) {
    modal.style.display = "flex";
    document.body.classList.add("modal-open");
  }

  function closeModal(modal) {
    modal.style.display = "none";
    document.body.classList.remove("modal-open");
  }

  function formatDate(timestamp) {
    const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return d.toLocaleString();
  }

  function updateLocalStorage() {
    localStorage.setItem("unreadTopics", JSON.stringify([...unreadTopics]));
    localStorage.setItem("favoriteTopics", JSON.stringify([...favoriteTopics]));
  }

  // ================================
  // Fetch and Render Topics
  // ================================
  async function fetchTopics() {
    const snapshot = await db.collection("topics").orderBy("createdAt", "desc").get();
    allTopics = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const totalComments = await countComments(doc.id);
      allTopics.push({
        id: doc.id,
        ...data,
        totalComments,
      });
    }
    renderTopics();
  }

  async function countComments(topicId) {
    const commentsSnap = await db
      .collection("topics")
      .doc(topicId)
      .collection("comments")
      .get();
    let total = 0;
    commentsSnap.forEach((doc) => {
      total += 1;
      const replies = doc.data().replies || [];
      total += replies.length;
    });
    return total;
  }

  async function renderTopics(filterText = "") {
    if (!topicListEl) return;
    topicListEl.innerHTML = "";
    const query = filterText.toLowerCase().trim();
    const unreadSearch = query === "unread";

    const sorted = [...allTopics].sort((a, b) => {
      const aFav = favoriteTopics.has(a.id);
      const bFav = favoriteTopics.has(b.id);
      if (aFav && !bFav) return -1;
      if (!aFav && bFav) return 1;
      return (b.viewCount || 0) - (a.viewCount || 0);
    });

    for (const topic of sorted) {
      const matchesQuery =
        !query ||
        (unreadSearch && unreadTopics.has(topic.id)) ||
        topic.title.toLowerCase().includes(query) ||
        topic.body.toLowerCase().includes(query);

      if (!matchesQuery) continue;

      const topicEl = document.createElement("div");
      topicEl.className = "topic-card";
      if (favoriteTopics.has(topic.id)) topicEl.style.borderTopColor = "#ffb7c5";

      topicEl.innerHTML = `
        <div class="topic-title">${topic.title}</div>
        <div class="topic-keywords">
          ${(topic.keywords || [])
            .map((kw) => `<span class="keyword-chip">${kw}</span>`)
            .join("")}
        </div>
        <div class="topic-footer">
          <span>${formatDate(topic.createdAt)} • 💬 ${topic.totalComments || 0}</span>
          <span class="topic-stats">${topic.viewCount || 0} views</span>
        </div>
      `;

      if (unreadTopics.has(topic.id)) {
        const dot = document.createElement("div");
        dot.className = "red-dot";
        topicEl.querySelector(".topic-footer").appendChild(dot);
      }

      topicEl.addEventListener("click", () => openTopicModal(topic));
      topicEl.addEventListener("dblclick", () => toggleFavorite(topic.id));

      topicListEl.appendChild(topicEl);
    }
  }

  // ================================
  // Topic Modal
  // ================================
  async function openTopicModal(topic) {
    selectedTopicId = topic.id;
    unreadTopics.delete(topic.id);
    updateLocalStorage();

    modalTopicTitle.textContent = topic.title;
    modalTopicBody.innerHTML = `<p>${topic.body.replace(/\n/g, "<br>")}</p>`;
    modalTopicMeta.innerHTML = `${formatDate(topic.createdAt)} | ${topic.viewCount || 0} views`;

    openModal(topicModal);

    // Always increment view count (each click adds one)
    await db.collection("topics").doc(topic.id).update({
      viewCount: firebase.firestore.FieldValue.increment(1),
    });

    loadComments(topic.id);
  }

  closeTopicModal.addEventListener("click", () => closeModal(topicModal));
  closeAddTopic.addEventListener("click", () => closeModal(addTopicModal));

  // ================================
  // Comments & Replies
  // ================================
  async function loadComments(topicId) {
    commentList.innerHTML = "";
    const snapshot = await db
      .collection("topics")
      .doc(topicId)
      .collection("comments")
      .orderBy("createdAt", "asc")
      .get();

    snapshot.forEach((doc) => {
      const comment = { id: doc.id, ...doc.data() };
      renderComment(comment);
    });
  }

  function renderComment(comment, parentEl = commentList) {
    const el = document.createElement("div");
    el.className = "comment";
    el.innerHTML = `
      <div class="comment-user"><b>${comment.userName}</b></div>
      ${
        comment.reference
          ? `<div class="reference-block" data-pos="${comment.referencePos}">
              "${comment.reference}" 
            </div>`
          : ""
      }
      <div class="comment-text">${comment.text}</div>
      <button class="reply-btn">Reply</button>
      <div class="replies"></div>
    `;
    const repliesContainer = el.querySelector(".replies");
    const replyBtn = el.querySelector(".reply-btn");

    replyBtn.addEventListener("click", () => {
      const replyBox = document.createElement("div");
      replyBox.className = "reply-box";
      const replyInput = document.createElement("textarea");
      replyInput.placeholder = "Write a reply...";
      const sendReply = document.createElement("button");
      sendReply.textContent = "Send";
      replyBox.appendChild(replyInput);
      replyBox.appendChild(sendReply);
      repliesContainer.appendChild(replyBox);

      sendReply.addEventListener("click", async () => {
        const replyText = replyInput.value.trim();
        if (!replyText) return;
        const replyData = {
          userName: username,
          text: replyText,
          createdAt: new Date(),
        };
        await db
          .collection("topics")
          .doc(selectedTopicId)
          .collection("comments")
          .doc(comment.id)
          .update({
            replies: firebase.firestore.FieldValue.arrayUnion(replyData),
          });
        showToast("Reply added!");
        loadComments(selectedTopicId);
      });
    });

    if (comment.replies && comment.replies.length > 0) {
      for (const rep of comment.replies) {
        const replyEl = document.createElement("div");
        replyEl.className = "reply";
        replyEl.innerHTML = `<b>${rep.userName}:</b> ${rep.text}`;
        repliesContainer.appendChild(replyEl);
      }
    }

    parentEl.appendChild(el);
  }

  commentForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = commentInput.value.trim();
    if (!text) return;

    const newComment = {
      userName: username,
      text,
      createdAt: new Date(),
      reference: selectedReferenceText || null,
    };

    await db
      .collection("topics")
      .doc(selectedTopicId)
      .collection("comments")
      .add(newComment);

    commentInput.value = "";
    referencePreview.innerHTML = "";
    selectedReferenceText = "";
    showToast("Comment added!");
    loadComments(selectedTopicId);
  });

  // ================================
  // Quoting / Referencing System
  // ================================
  quoteBtn.addEventListener("click", () => {
    referenceBody.innerHTML = modalTopicBody.innerHTML;
    openModal(referenceModal);
    let selection = "";

    referenceBody.addEventListener("mouseup", () => {
      selection = window.getSelection().toString();
    });

    confirmReference.onclick = () => {
      if (selection.trim()) {
        selectedReferenceText = selection.trim();
        referencePreview.innerHTML = `
          <div class="reference-block">${selectedReferenceText}</div>
        `;
      }
      closeModal(referenceModal);
    };

    cancelReference.onclick = () => closeModal(referenceModal);
  });

  referencePreview.addEventListener("click", (e) => {
    const text = e.target.textContent;
    const allText = modalTopicBody.innerText;
    const index = allText.indexOf(text);
    if (index >= 0) {
      modalTopicBody.scrollTo({
        top: index * 0.3,
        behavior: "smooth",
      });
    }
  });

  // ================================
  // Favorites
  // ================================
  function toggleFavorite(topicId) {
    if (favoriteTopics.has(topicId)) {
      favoriteTopics.delete(topicId);
      showToast("Removed from favorites 💔");
    } else {
      favoriteTopics.add(topicId);
      showToast("Favorited 💖");
    }
    updateLocalStorage();
    renderTopics(searchInput.value);
  }

  // ================================
  // Add Topic
  // ================================
  addTopicBtn.addEventListener("click", () => openModal(addTopicModal));

  saveTopicBtn.addEventListener("click", async () => {
    const title = topicTitleInput.value.trim();
    const body = topicBodyInput.value.trim();
    const keywords = topicKeywordsInput.value
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    if (!title || !body) return showToast("Please fill out title and body!");

    await db.collection("topics").add({
      title,
      body,
      keywords,
      createdAt: new Date(),
      viewCount: 0,
    });

    topicTitleInput.value = "";
    topicBodyInput.value = "";
    topicKeywordsInput.value = "";
    closeModal(addTopicModal);
    showToast("Topic added!");
    fetchTopics();
  });

  // ================================
  // Search
  // ================================
  searchInput.addEventListener("input", (e) => renderTopics(e.target.value));

  // ================================
  // Init Load
  // ================================
  fetchTopics();
});
