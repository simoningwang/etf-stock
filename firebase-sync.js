/**
 * Firebase Auth (Google 登入) + Firestore 跨裝置即時同步模組
 */
(function () {
  const firebaseConfig = {
    apiKey: 'AIzaSyDScvsitcdMwsNi0Kap7Guu7gMhB3hbwqM',
    authDomain: 'etf-stock-1e704.firebaseapp.com',
    projectId: 'etf-stock-1e704',
    storageBucket: 'etf-stock-1e704.firebasestorage.app',
    messagingSenderId: '589895183021',
    appId: '1:589895183021:web:f5cdf886c4bd39c5f4b424'
  };

  let auth = null;
  let db = null;
  let unsubscribeSnapshot = null;

  function isAvailable() {
    return typeof window.firebase !== 'undefined';
  }

  function init({ onAuthChange, onTransactionsSync, onError }) {
    if (!isAvailable()) return;

    if (!window.firebase.apps.length) {
      window.firebase.initializeApp(firebaseConfig);
    }
    auth = window.firebase.auth();
    db = window.firebase.firestore();

    // 處理 redirect 登入回來的結果與錯誤
    auth.getRedirectResult().catch((err) => {
      if (err && onError) onError(err);
    });

    auth.onAuthStateChanged((user) => {
      if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
      }

      onAuthChange(user || null);

      if (user) {
        const colRef = db
          .collection('users')
          .doc(user.uid)
          .collection('transactions');

        unsubscribeSnapshot = colRef.onSnapshot(
          (snapshot) => {
            const list = [];
            snapshot.forEach((doc) => {
              const d = doc.data();
              if (d && d.code) {
                list.push({ ...d, id: doc.id });
              }
            });
            onTransactionsSync(list);
          },
          (err) => {
            if (onError) onError(err);
          }
        );
      }
    });
  }

  async function signIn() {
    if (!auth) throw new Error('Firebase 尚未載入');
    const provider = new window.firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      const result = await auth.signInWithPopup(provider);
      return result && result.user ? result.user : auth.currentUser;
    } catch (err) {
      if (
        err &&
        (err.code === 'auth/popup-blocked' ||
          err.code === 'auth/operation-not-supported-in-this-environment')
      ) {
        await auth.signInWithRedirect(provider);
        return null;
      }
      throw err;
    }
  }

  async function signOut() {
    if (!auth) return;
    await auth.signOut();
  }

  async function saveTransaction(uid, tx) {
    if (!db || !uid) return;
    await db
      .collection('users')
      .doc(uid)
      .collection('transactions')
      .doc(tx.id)
      .set(tx);
  }

  async function deleteTransaction(uid, txId) {
    if (!db || !uid) return;
    await db
      .collection('users')
      .doc(uid)
      .collection('transactions')
      .doc(txId)
      .delete();
  }

  async function replaceAllTransactions(uid, txList) {
    if (!db || !uid) return;
    const colRef = db.collection('users').doc(uid).collection('transactions');
    const existing = await colRef.get();
    const batch = db.batch();
    existing.forEach((doc) => batch.delete(doc.ref));
    for (const tx of txList) {
      const id = tx.id || 'tx-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      batch.set(colRef.doc(id), { ...tx, id });
    }
    await batch.commit();
  }

  async function uploadTransactions(uid, txList) {
    if (!db || !uid || !Array.isArray(txList) || txList.length === 0) return;
    const colRef = db.collection('users').doc(uid).collection('transactions');
    const batch = db.batch();
    for (const tx of txList) {
      const id = tx.id || 'tx-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      batch.set(colRef.doc(id), { ...tx, id });
    }
    await batch.commit();
  }

  window.FirebaseSync = {
    isAvailable,
    init,
    signIn,
    signOut,
    saveTransaction,
    deleteTransaction,
    replaceAllTransactions,
    uploadTransactions
  };
})();
