/*!
* CubeTimer — Online Profile & Friends (Firebase)
*
* Optional online layer on top of the local timer. The stopwatch, local
* solves and local statistics in js/timer.js never depend on this file:
* if Firebase fails or is missing, the timer keeps working exactly as before.
*
* ---------------------------------------------------------------------------
* Firestore data structure (mirrored by firestore.rules):
*
*   usernames/{name}          Uniqueness registry. The document id is the
*                             lowercased username, so two users can never
*                             claim the same name (a second create simply
*                             fails). Fields: uid, name, displayName,
*                             createdAt.
*
*   friendCodes/{code}        Uniqueness registry for friend codes. The
*                             document id IS the code (e.g. "CUBE-4821"),
*                             so codes can never collide. Fields: uid, code,
*                             createdAt. Readable by any signed-in user so a
*                             code can be looked up when adding a friend.
*
*   users/{uid}               Public profile + aggregate statistics. Fields:
*                             uid, username, friendCode, personalBest (ms,
*                             null when empty), averageTime (ms, null when
*                             empty), totalSolves, totalTime (ms), createdAt,
*                             updatedAt. The aggregates are recomputed from
*                             the local solve list on every sync - one
*                             document write per solve, zero reads. This is
*                             cheap enough for the Firebase Spark plan.
*
*   users/{uid}/friends/{fuid} One-way friend entries; the document id is
*                             the friend's uid. Only the owner may read or
*                             write their own list. Rules also require the
*                             friend's users/{fuid} document to exist.
*
*   solves/{solveId}          One document per solve. The document id is the
*                             SAME id as the local solve, which makes
*                             deletion a direct document delete and keeps a
*                             user from ever touching another user's solve.
*                             Fields: uid, time (ms), date (ISO string).
*
* Authorization NEVER comes from the client - it comes from Firebase
* Authentication + Firestore Security Rules (firestore.rules).
* ---------------------------------------------------------------------------
*/

import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously, deleteUser } from 'firebase/auth';
import {
    getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
    collection, getDocs, writeBatch, serverTimestamp
} from 'firebase/firestore';

// ---------------------------------------------------------------------------
// Firebase web app configuration
// (Firebase Console → Project settings → Your apps → Web app)
// ---------------------------------------------------------------------------

var firebaseConfig = {
    apiKey: 'AIzaSyAao4Q90VL6D4AktWrllHa9Gi4hUUODA9Y',
    authDomain: 'cubetimer-d7031.firebaseapp.com',
    projectId: 'cubetimer-d7031',
    storageBucket: 'cubetimer-d7031.firebasestorage.app',
    messagingSenderId: '150262671469',
    appId: '1:150262671469:web:244e10170d306cae777764'
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// localStorage keys (mirror the ones used in js/timer.js).
var SOLVES_KEY = 'cubeTimer.solves';
var SYNC_KEY = 'cubeTimer.onlineSync'; // { uid, synced: [ids], pendingDeletes: [ids] }

var app = null;
var auth = null;
var db = null;
var currentUid = null;      // Firebase UID of the signed-in anonymous user
var profile = null;         // cached users/{uid} document data
var friends = [];           // cached friend documents
var firebaseReady = false;  // SDK initialised
var authSettled = false;    // first onAuthStateChanged callback has fired

// Hooks called by js/timer.js whenever a solve is saved or deleted locally.
// They are a no-op while the user has no online profile.
window.CubeTimer = window.CubeTimer || {};
window.CubeTimer.onSolveSaved = handleSolveSaved;
window.CubeTimer.onSolveDeleted = handleSolveDeleted;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function init() {
    try {
        app = initializeApp(firebaseConfig);
        auth = getAuth(app);
        db = getFirestore(app);
        firebaseReady = true;
    } catch (e) {
        // Firebase failed to load — online features stay off, timer works.
        firebaseReady = false;
        renderProfile();
        renderFriends();
        renderLeaderboard();
        return;
    }

    // Restores an existing anonymous session if there is one. No account is
    // ever created here — that only happens when the user clicks
    // "Create Profile" (see createProfile).
    onAuthStateChanged(auth, handleAuthState);

    // When the connection comes back, sync anything that is pending.
    window.addEventListener('online', function () {
        if (!currentUid) {
            return;
        }
        setProfileStatus('Back online — syncing solves…', 'ok');
        syncPendingSolves().then(function () {
            renderAllOnline();
            setTimeout(function () {
                setProfileStatus('', '');
            }, 4000);
        });
    });
    window.addEventListener('offline', function () {
        if (currentUid) {
            setProfileStatus('You are offline — solves stay local and sync when you are back.', '');
        }
    });

    renderProfile();
    renderFriends();
    renderLeaderboard();
}

function handleAuthState(user) {
    authSettled = true;
    if (user && user.uid) {
        currentUid = user.uid;
        loadProfile().then(function () {
            renderAllOnline();
            return syncPendingSolves();
        }).then(function () {
            renderLeaderboard();
        }).catch(function () {
            // Non-fatal — the UI stays in a safe state.
        });
    } else {
        currentUid = null;
        profile = null;
        friends = [];
        renderAllOnline();
    }
}

function loadProfile() {
    if (!db || !currentUid) {
        profile = null;
        return Promise.resolve(null);
    }
    return getDoc(doc(db, 'users', currentUid)).then(function (snap) {
        profile = snap.exists() ? snap.data() : null;
        return profile;
    }).catch(function () {
        profile = null;
        return null;
    });
}

// ---------------------------------------------------------------------------
// Profile creation
// ---------------------------------------------------------------------------

function validateUsername(name) {
    if (!name) {
        return 'Please choose a username.';
    }
    if (!/^[A-Za-z0-9_-]{2,16}$/.test(name)) {
        return 'Use 2-16 letters, numbers, dashes or underscores.';
    }
    return null;
}

function generateFriendCode() {
    return 'CUBE-' + (1000 + Math.floor(Math.random() * 9000));
}

function isTransientError(err) {
    var code = err && err.code;
    if (!code) {
        return false;
    }
    // Friend-code collisions, already-taken usernames and network blips are
    // all retryable; permanent rule violations are not.
    return ['aborted', 'already-exists', 'permission-denied', 'unavailable',
        'deadline-exceeded', 'network-error', 'internal', 'resource-exhausted'
    ].indexOf(code) !== -1;
}

function createProfileDocs(username, nameId, code) {
    var batch = writeBatch(db);
    batch.set(doc(db, 'usernames', nameId), {
        uid: currentUid,
        name: nameId,
        displayName: username,
        createdAt: serverTimestamp()
    });
    batch.set(doc(db, 'friendCodes', code), {
        uid: currentUid,
        code: code,
        createdAt: serverTimestamp()
    });
    batch.set(doc(db, 'users', currentUid), {
        uid: currentUid,
        username: username,
        friendCode: code,
        personalBest: null,
        averageTime: null,
        totalSolves: 0,
        totalTime: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    });
    return batch.commit().then(function () {
        return code;
    });
}

function createProfile() {
    if (!firebaseReady || !db) {
        setProfileStatus('Online features are unavailable right now — the timer keeps working.', 'error');
        return;
    }

    var input = document.getElementById('onlineUsername');
    var username = input ? input.value.trim() : '';
    var validation = validateUsername(username);
    if (validation) {
        setProfileStatus(validation, 'error');
        return;
    }

    setProfileBusy(true);
    setProfileStatus('Creating your profile…', 'ok');
    var nameId = username.toLowerCase();
    var attempts = 0;
    var MAX_ATTEMPTS = 5;

    var proceed = function (user) {
        currentUid = user.uid;

        // 1) Username availability — the real guarantee is the document id
        //    itself (a second user can never create the same id).
        getDoc(doc(db, 'usernames', nameId)).then(function (snap) {
            if (snap.exists()) {
                throw { code: 'username-taken' };
            }
            return createProfileDocs(username, nameId, generateFriendCode());
        }).then(function (code) {
            profile = {
                uid: currentUid,
                username: username,
                friendCode: code,
                personalBest: null,
                averageTime: null,
                totalSolves: 0,
                totalTime: 0
            };
            resetSyncState(); // new account → sync every local solve to it
            renderProfile();
            renderFriends();
            renderLeaderboard();
            setProfileBusy(false);
            setProfileStatus('Profile created — syncing your solves…', 'ok');
            return syncPendingSolves();
        }).then(function () {
            renderLeaderboard();
            setProfileStatus('Profile created!', 'ok');
        }).catch(function (err) {
            if (err && err.code === 'username-taken') {
                setProfileBusy(false);
                setProfileStatus('That username is already taken. Try another.', 'error');
                return;
            }
            // A failed batch can mean another user just claimed this username
            // (or a friend-code collision) — re-check before retrying.
            getDoc(doc(db, 'usernames', nameId)).then(function (snap) {
                if (snap.exists()) {
                    setProfileBusy(false);
                    setProfileStatus('That username is already taken. Try another.', 'error');
                    return;
                }
                if (attempts < MAX_ATTEMPTS && isTransientError(err)) {
                    // Most likely a friend-code collision — retry with a new code.
                    attempts += 1;
                    proceed(user);
                    return;
                }
                setProfileBusy(false);
                setProfileStatus('Could not create your profile — check your connection.', 'error');
            }).catch(function () {
                setProfileBusy(false);
                setProfileStatus('Could not create your profile — check your connection.', 'error');
            });
        });
    };

    if (auth.currentUser) {
        proceed(auth.currentUser);
        return;
    }
    // Anonymous sign-in happens only here — never automatically on page load.
    signInAnonymously(auth).then(function (credential) {
        proceed(credential.user);
    }).catch(function (err) {
        setProfileBusy(false);
        if (err && err.code === 'auth/operation-not-allowed') {
            setProfileStatus('Anonymous sign-in is not enabled in the Firebase Console.', 'error');
        } else if (err && err.code === 'auth/invalid-api-key') {
            setProfileStatus('Firebase config looks wrong — check the apiKey in js/firebase.js.', 'error');
        } else {
            setProfileStatus('Could not sign in — check your connection.', 'error');
        }
    });
}

// ---------------------------------------------------------------------------
// Friends
// ---------------------------------------------------------------------------

function addFriend() {
    if (!currentUid || !profile) {
        setFriendsStatus('Create an online profile first.', 'error');
        return;
    }
    if (!navigator.onLine) {
        setFriendsStatus('You are offline — try again when you are back online.', 'error');
        return;
    }

    var input = document.getElementById('onlineFriendCode');
    var code = input ? input.value.trim().toUpperCase() : '';
    if (/^\d{4}$/.test(code)) {
        code = 'CUBE-' + code; // accept a bare "4821" too
    }
    if (!/^CUBE-\d{4}$/.test(code)) {
        setFriendsStatus('Enter a friend code like CUBE-1234.', 'error');
        return;
    }
    if (code === profile.friendCode) {
        setFriendsStatus('That is your own friend code.', 'error');
        return;
    }

    setFriendsBusy(true);
    var friendUid = null;
    getDoc(doc(db, 'friendCodes', code)).then(function (snap) {
        if (!snap.exists()) {
            throw { code: 'code-not-found' };
        }
        friendUid = snap.data().uid;
        if (friendUid === currentUid) {
            throw { code: 'own-code' };
        }
        return getDoc(doc(db, 'users', currentUid, 'friends', friendUid));
    }).then(function (existing) {
        if (existing.exists()) {
            throw { code: 'already-friends' };
        }
        return setDoc(doc(db, 'users', currentUid, 'friends', friendUid), {
            addedAt: serverTimestamp()
        });
    }).then(function () {
        setFriendsBusy(false);
        if (input) {
            input.value = '';
        }
        setFriendsStatus('Friend added!', 'ok');
        return loadFriends();
    }).then(function () {
        renderFriends();
        renderLeaderboard();
    }).catch(function (err) {
        setFriendsBusy(false);
        var messages = {
            'code-not-found': 'No user has that friend code.',
            'own-code': 'That is your own friend code.',
            'already-friends': 'You are already friends with that code.'
        };
        setFriendsStatus(
            messages[err && err.code] || 'Could not add friend — check your connection.',
            'error'
        );
    });
}

function removeFriend(friendUid) {
    if (!db || !currentUid) {
        return;
    }
    deleteDoc(doc(db, 'users', currentUid, 'friends', friendUid)).then(function () {
        return loadFriends();
    }).then(function () {
        renderFriends();
        renderLeaderboard();
        setFriendsStatus('Friend removed.', 'ok');
    }).catch(function () {
        setFriendsStatus('Could not remove friend — check your connection.', 'error');
    });
}

function toggleAddFriend() {
    var input = document.getElementById('onlineFriendCode');
    if (input) {
        input.focus();
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function loadFriends() {
    if (!db || !currentUid) {
        friends = [];
        return Promise.resolve(friends);
    }
    return getDocs(collection(db, 'users', currentUid, 'friends')).then(function (snap) {
        var uids = snap.docs.map(function (d) {
            return d.id;
        });
        return Promise.all(uids.map(function (uid) {
            return getDoc(doc(db, 'users', uid)).then(function (s) {
                return s.exists() ? s.data() : null;
            }).catch(function () {
                return null;
            });
        }));
    }).then(function (docs) {
        friends = docs.filter(Boolean);
        return friends;
    }).catch(function () {
        friends = [];
        return friends;
    });
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------
// NOTE: there is intentionally no "Log Out" button. Accounts are anonymous
// and Firebase deletes the session on sign-out, so the user could never sign
// back in as the same account — logging out would just lose the profile.
// Removing the account (if ever needed) is done with "Delete Account".

function copyFriendCode() {
    if (!profile || !profile.friendCode) {
        return;
    }
    var text = profile.friendCode;
    var done = function () {
        setProfileStatus('Friend code copied!', 'ok');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {
            legacyCopy(text, done);
        });
    } else {
        legacyCopy(text, done);
    }
}

function legacyCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
        done();
    } catch (e) {
        setProfileStatus('Could not copy — copy it manually.', 'error');
    }
    document.body.removeChild(ta);
}

// ---------------------------------------------------------------------------
// Account deletion
// ---------------------------------------------------------------------------

// Two-step inline confirmation: the first click arms the button, the second
// click performs the deletion (it resets after a few seconds if not clicked).
var deleteArmed = false;
var deleteArmedTimer = null;

function resetDeleteArmed() {
    deleteArmed = false;
    if (deleteArmedTimer) {
        clearTimeout(deleteArmedTimer);
        deleteArmedTimer = null;
    }
}

function handleDeleteClick(btn) {
    if (!deleteArmed) {
        deleteArmed = true;
        btn.textContent = 'Click again to confirm';
        btn.classList.add('danger-armed');
        deleteArmedTimer = setTimeout(function () {
            resetDeleteArmed();
            renderProfile(); // re-render → button back to normal
        }, 5000);
        return;
    }
    resetDeleteArmed();
    deleteAccount();
}

// Deletes the online account: friend entries, solves, profile, username and
// friend-code registries, then the Firebase anonymous account itself. Local
// solves on this device are intentionally kept. (Solves synced from another
// device are not covered by this device's sync state and are left alone.)
// Requires the updated firestore.rules — owners may delete their usernames/
// and friendCodes/ docs.
function deleteAccount() {
    if (!db || !currentUid || !profile) {
        setProfileStatus('Create an online profile first.', 'error');
        return;
    }
    if (!navigator.onLine) {
        setProfileStatus('You are offline — try again when you are back online.', 'error');
        return;
    }

    var uid = currentUid;
    var nameId = (profile.username || '').toLowerCase();
    var code = profile.friendCode;
    setProfileStatus('Deleting your account…', 'ok');
    setDeleteBusy(true);

    // Solve documents — the ids the app has synced are tracked locally. They
    // are removed in small chunks first (batches are limited to 500 writes),
    // then the small bounded profile set below goes in one atomic batch.
    var solveIds = [];
    var seen = {};
    var state = loadSyncState();
    state.synced.concat(state.pendingDeletes).forEach(function (id) {
        if (!seen[id]) {
            seen[id] = true;
            solveIds.push(id);
        }
    });

    deleteSolveDocs(solveIds).then(function () {
        return getDocs(collection(db, 'users', uid, 'friends'));
    }).then(function (snap) {
        var batch = writeBatch(db);
        snap.docs.forEach(function (d) {
            batch.delete(d.ref);
        });
        batch.delete(doc(db, 'users', uid));
        if (nameId) {
            batch.delete(doc(db, 'usernames', nameId));
        }
        if (code) {
            batch.delete(doc(db, 'friendCodes', code));
        }
        return batch.commit();
    }).then(function () {
        // The online data is gone — reset local state and the UI first, so a
        // failure of the final step never leaves a stale profile on screen.
        saveSyncState({ uid: null, synced: [], pendingDeletes: [] });
        currentUid = null;
        profile = null;
        friends = [];
        setDeleteBusy(false);
        renderAllOnline();

        // Remove the anonymous authentication account itself.
        if (!auth.currentUser) {
            setProfileStatus('Account deleted — your local solves stay on this device.', 'ok');
            return;
        }
        deleteUser(auth.currentUser).then(function () {
            setProfileStatus('Account deleted — your local solves stay on this device.', 'ok');
        }).catch(function () {
            setProfileStatus('Your data was deleted, but the sign-in could not be removed — log out or delete it in the Firebase console.', 'error');
        });
    }).catch(function (err) {
        setDeleteBusy(false);
        if (err && err.code === 'permission-denied') {
            setProfileStatus('Could not delete — publish the updated firestore.rules in the Firebase console, then try again.', 'error');
        } else {
            setProfileStatus('Could not delete your account — check your connection.', 'error');
        }
    });
}

// Deletes solve documents in chunks of 400 (Firestore batches cap at 500
// writes) so account deletion also works for users with many solves.
function deleteSolveDocs(ids) {
    var CHUNK = 400;
    var chunks = [];
    for (var i = 0; i < ids.length; i += CHUNK) {
        chunks.push(ids.slice(i, i + CHUNK));
    }
    return chunks.reduce(function (chain, chunkIds) {
        return chain.then(function () {
            return Promise.all(chunkIds.map(function (id) {
                return deleteDoc(doc(db, 'solves', id));
            }));
        });
    }, Promise.resolve());
}

// ---------------------------------------------------------------------------
// Solve synchronisation
// ---------------------------------------------------------------------------

function loadLocalSolves() {
    try {
        var raw = localStorage.getItem(SOLVES_KEY);
        if (!raw) {
            return [];
        }
        var arr = JSON.parse(raw);
        if (!Array.isArray(arr)) {
            return [];
        }
        return arr.filter(function (s) {
            return s && typeof s.time === 'number' && isFinite(s.time) && s.time >= 0 &&
                typeof s.date === 'string' && typeof s.id === 'string';
        });
    } catch (e) {
        return [];
    }
}

function computeStats(solves) {
    if (!solves.length) {
        return { personalBest: null, averageTime: null, totalSolves: 0, totalTime: 0 };
    }
    var total = solves.reduce(function (a, b) {
        return a + b.time;
    }, 0);
    return {
        personalBest: Math.min.apply(null, solves.map(function (s) {
            return s.time;
        })),
        averageTime: total / solves.length,
        totalSolves: solves.length,
        totalTime: total
    };
}

function applyStats(target, stats) {
    target.personalBest = stats.personalBest;
    target.averageTime = stats.averageTime;
    target.totalSolves = stats.totalSolves;
    target.totalTime = stats.totalTime;
}

function loadSyncState() {
    try {
        var raw = localStorage.getItem(SYNC_KEY);
        if (!raw) {
            return { uid: null, synced: [], pendingDeletes: [] };
        }
        var st = JSON.parse(raw);
        return {
            uid: st.uid || null,
            synced: Array.isArray(st.synced) ? st.synced : [],
            pendingDeletes: Array.isArray(st.pendingDeletes) ? st.pendingDeletes : []
        };
    } catch (e) {
        return { uid: null, synced: [], pendingDeletes: [] };
    }
}

function saveSyncState(state) {
    try {
        localStorage.setItem(SYNC_KEY, JSON.stringify(state));
    } catch (e) {
        /* ignore — sync bookkeeping is best-effort */
    }
}

function resetSyncState() {
    saveSyncState({ uid: currentUid, synced: [], pendingDeletes: [] });
}

function chunk(arr, size) {
    var out = [];
    for (var i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
    }
    return out;
}

// Writes the aggregate statistics into users/{uid} from the local solve list.
// One cheap document write per sync — no reads required.
function pushStats() {
    if (!db || !currentUid || !navigator.onLine) {
        return Promise.resolve(false);
    }
    var stats = computeStats(loadLocalSolves());
    return updateDoc(doc(db, 'users', currentUid), {
        personalBest: stats.personalBest,
        averageTime: stats.averageTime,
        totalSolves: stats.totalSolves,
        totalTime: stats.totalTime,
        updatedAt: serverTimestamp()
    }).then(function () {
        if (profile) {
            applyStats(profile, stats);
        }
        return true;
    }).catch(function () {
        return false;
    });
}

// Synchronises everything that is missing: pending deletions first, then
// unsynced solves, then the aggregate statistics. Called on login, on the
// 'online' event and after every profile change. Never throws.
function syncPendingSolves() {
    if (!db || !currentUid || !navigator.onLine) {
        return Promise.resolve(false);
    }
    var state = loadSyncState();
    if (state.uid !== currentUid) {
        state = { uid: currentUid, synced: [], pendingDeletes: [] };
    }
    var local = loadLocalSolves();

    var deletes = state.pendingDeletes.slice().map(function (id) {
        return deleteDoc(doc(db, 'solves', id)).then(function () {
            state.synced = state.synced.filter(function (x) {
                return x !== id;
            });
            state.pendingDeletes = state.pendingDeletes.filter(function (x) {
                return x !== id;
            });
        }).catch(function () {
            /* still offline — stays pending for the next attempt */
        });
    });

    return Promise.all(deletes).then(function () {
        var unsynced = local.filter(function (s) {
            return state.synced.indexOf(s.id) === -1 &&
                state.pendingDeletes.indexOf(s.id) === -1;
        });
        // Upload in small chunks so a large backlog stays polite.
        return chunk(unsynced, 20).reduce(function (chain, batchSolves) {
            return chain.then(function () {
                return Promise.all(batchSolves.map(function (s) {
                    return setDoc(doc(db, 'solves', s.id), {
                        uid: currentUid,
                        time: s.time,
                        date: s.date
                    }).then(function () {
                        state.synced.push(s.id);
                    }).catch(function () {
                        /* offline — retried on the next sync */
                    });
                }));
            });
        }, Promise.resolve());
    }).then(function () {
        saveSyncState(state);
        return pushStats();
    });
}

// Called by js/timer.js right after a solve is saved locally.
function handleSolveSaved(solve) {
    if (!db || !currentUid || !solve) {
        return;
    }
    if (profile) {
        applyStats(profile, computeStats(loadLocalSolves()));
        renderLeaderboard();
    }
    if (!navigator.onLine) {
        return; // picked up later by syncPendingSolves
    }
    var state = loadSyncState();
    if (state.uid !== currentUid) {
        state = { uid: currentUid, synced: [], pendingDeletes: [] };
    }
    if (state.synced.indexOf(solve.id) !== -1) {
        return;
    }
    setDoc(doc(db, 'solves', solve.id), {
        uid: currentUid,
        time: solve.time,
        date: solve.date
    }).then(function () {
        state.synced.push(solve.id);
        saveSyncState(state);
        return pushStats();
    }).then(function () {
        renderLeaderboard();
    }).catch(function () {
        /* offline or denied — syncPendingSolves retries later */
    });
}

// Called by js/timer.js right after a solve is deleted locally.
function handleSolveDeleted(id) {
    if (!db || !currentUid || !id) {
        return;
    }
    if (profile) {
        applyStats(profile, computeStats(loadLocalSolves()));
    }
    var state = loadSyncState();
    if (state.uid !== currentUid) {
        state = { uid: currentUid, synced: [], pendingDeletes: [] };
    }
    var wasSynced = state.synced.indexOf(id) !== -1;
    if (wasSynced) {
        state.synced = state.synced.filter(function (x) {
            return x !== id;
        });
        state.pendingDeletes.push(id);
        saveSyncState(state);
        if (navigator.onLine) {
            deleteDoc(doc(db, 'solves', id)).then(function () {
                state.pendingDeletes = state.pendingDeletes.filter(function (x) {
                    return x !== id;
                });
                saveSyncState(state);
                return pushStats();
            }).then(function () {
                renderLeaderboard();
            }).catch(function () {
                /* retried on the next sync */
            });
        }
    }
    renderLeaderboard();
}

// ---------------------------------------------------------------------------
// Rendering (all text is inserted via textContent — friend-supplied strings
// are never treated as HTML)
// ---------------------------------------------------------------------------

function renderAllOnline() {
    renderProfile();
    renderFriends();
    renderLeaderboard();
}

function renderProfile() {
    var box = document.getElementById('onlineProfile');
    if (!box) {
        return;
    }
    resetDeleteArmed(); // any re-render cancels a pending delete confirmation
    box.textContent = '';

    if (!firebaseReady) {
        box.appendChild(emptyNote('Online features are unavailable right now — the timer keeps working.'));
        return;
    }
    if (!authSettled) {
        box.appendChild(emptyNote('Loading online profile…'));
        return;
    }
    if (!currentUid || !profile) {
        // Signed out (or signed in without a profile yet) → create form.
        var intro = document.createElement('p');
        intro.className = 'online-intro';
        intro.textContent = 'Compare your solves with friends. Optional — the timer works fine without it.';

        var form = document.createElement('div');
        form.className = 'online-form';

        var input = document.createElement('input');
        input.id = 'onlineUsername';
        input.type = 'text';
        input.className = 'online-input';
        input.placeholder = 'Username';
        input.setAttribute('aria-label', 'Username');
        input.maxLength = 16;
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                createProfile();
            }
        });

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'onlineCreateBtn';
        btn.className = 'online-btn primary';
        btn.textContent = 'Create Profile';
        btn.addEventListener('click', createProfile);

        form.appendChild(input);
        form.appendChild(btn);
        box.appendChild(intro);
        box.appendChild(form);
        box.appendChild(statusEl('onlineProfileStatus'));
        box.appendChild(footnote('Anonymous account — no email or password needed.'));
        return;
    }

    // Signed in with a profile.
    var user = document.createElement('div');
    user.className = 'online-user';

    var name = document.createElement('div');
    name.className = 'online-user-name';
    name.textContent = profile.username;

    var codeRow = document.createElement('div');
    codeRow.className = 'online-code-row';
    var codeLabel = document.createElement('span');
    codeLabel.className = 'online-code-label';
    codeLabel.textContent = 'Friend Code: ';
    var codeVal = document.createElement('span');
    codeVal.className = 'online-code';
    codeVal.textContent = profile.friendCode;
    codeRow.appendChild(codeLabel);
    codeRow.appendChild(codeVal);
    user.appendChild(name);
    user.appendChild(codeRow);
    box.appendChild(user);

    var statsLine = document.createElement('div');
    statsLine.className = 'online-user-stats';
    statsLine.textContent = 'Best ' + formatTime(profile.personalBest) +
        ' · Avg ' + formatTime(profile.averageTime) +
        ' · ' + (profile.totalSolves || 0) + ' solves' +
        ' · ' + formatDuration(profile.totalTime || 0);
    box.appendChild(statsLine);

    var actions = document.createElement('div');
    actions.className = 'online-actions';
    actions.appendChild(button('online-btn', 'Copy Code', copyFriendCode));
    actions.appendChild(button('online-btn', 'Add Friend', toggleAddFriend));
    box.appendChild(actions);

    var danger = document.createElement('div');
    danger.className = 'online-danger-zone';
    var delBtn = button('online-btn danger', 'Delete Account', function () {
        handleDeleteClick(delBtn);
    });
    danger.appendChild(delBtn);
    var delNote = document.createElement('p');
    delNote.className = 'panel-footnote';
    delNote.textContent = 'Deletes your profile, friends and online solves. Your local solves on this device stay.';
    danger.appendChild(delNote);
    box.appendChild(danger);
    box.appendChild(statusEl('onlineProfileStatus'));
}

function renderFriends() {
    var box = document.getElementById('onlineFriends');
    if (!box) {
        return;
    }
    box.textContent = '';

    if (!firebaseReady) {
        box.appendChild(emptyNote('Online features are unavailable right now.'));
        return;
    }
    if (!authSettled) {
        box.appendChild(emptyNote('Loading…'));
        return;
    }
    if (!currentUid || !profile) {
        box.appendChild(emptyNote('Create an online profile to add friends.'));
        return;
    }

    var form = document.createElement('div');
    form.className = 'online-form';
    var input = document.createElement('input');
    input.id = 'onlineFriendCode';
    input.type = 'text';
    input.className = 'online-input';
    input.placeholder = 'CUBE-1234';
    input.setAttribute('aria-label', 'Friend code');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            addFriend();
        }
    });
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.id = 'onlineAddBtn';
    addBtn.className = 'online-btn';
    addBtn.textContent = 'Add';
    addBtn.addEventListener('click', addFriend);
    form.appendChild(input);
    form.appendChild(addBtn);
    box.appendChild(form);
    box.appendChild(statusEl('onlineFriendsStatus'));

    if (!friends.length) {
        box.appendChild(emptyNote('No friends yet — share your Friend Code so others can add you.'));
        return;
    }

    var ul = document.createElement('ul');
    ul.className = 'online-friends';
    friends.forEach(function (f) {
        var li = document.createElement('li');
        li.className = 'online-friend';

        var name = document.createElement('span');
        name.className = 'online-friend-name';
        name.textContent = f.username || 'Unknown';

        var stats = document.createElement('span');
        stats.className = 'online-friend-stats';
        stats.textContent = 'Best ' + formatTime(f.personalBest) +
            ' · Avg ' + formatTime(f.averageTime) +
            ' · ' + (f.totalSolves || 0) + ' solves';

        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'solve-delete';
        rm.setAttribute('aria-label', 'Remove ' + (f.username || 'friend'));
        var icon = document.createElement('i');
        icon.className = 'fas fa-trash-alt';
        rm.appendChild(icon);
        rm.addEventListener('click', function () {
            removeFriend(f.uid);
        });

        li.appendChild(name);
        li.appendChild(stats);
        li.appendChild(rm);
        ul.appendChild(li);
    });
    box.appendChild(ul);
}

function renderLeaderboard() {
    var box = document.getElementById('onlineLeaderboard');
    if (!box) {
        return;
    }
    box.textContent = '';

    if (!firebaseReady) {
        box.appendChild(emptyNote('Online features are unavailable right now.'));
        return;
    }
    if (!authSettled) {
        box.appendChild(emptyNote('Loading…'));
        return;
    }
    if (!currentUid || !profile) {
        box.appendChild(emptyNote('Create an online profile to compete with friends.'));
        return;
    }

    var rows = [{ // the current user always takes part
        uid: currentUid,
        username: profile.username,
        personalBest: profile.personalBest,
        averageTime: profile.averageTime,
        totalSolves: profile.totalSolves,
        you: true
    }];
    friends.forEach(function (f) {
        rows.push({
            uid: f.uid,
            username: f.username,
            personalBest: f.personalBest,
            averageTime: f.averageTime,
            totalSolves: f.totalSolves,
            you: false
        });
    });

    // Fastest personal best first; users without solves go to the end.
    rows.sort(function (a, b) {
        var ab = a.personalBest == null ? Infinity : a.personalBest;
        var bb = b.personalBest == null ? Infinity : b.personalBest;
        if (ab !== bb) {
            return ab - bb;
        }
        return (a.username || '').localeCompare(b.username || '');
    });

    var ol = document.createElement('ol');
    ol.className = 'online-leaderboard';
    rows.forEach(function (r, i) {
        var li = document.createElement('li');
        li.className = 'online-lb-row' + (r.you ? ' you' : '');

        var rank = document.createElement('span');
        rank.className = 'rank rank-' + (i + 1);
        rank.textContent = String(i + 1);

        var nameWrap = document.createElement('span');
        nameWrap.className = 'online-lb-name';
        nameWrap.textContent = r.username || 'Unknown';
        if (r.you) {
            var tag = document.createElement('span');
            tag.className = 'you-tag';
            tag.textContent = 'you';
            nameWrap.appendChild(tag);
        }

        var best = document.createElement('span');
        best.className = 'online-lb-meta online-lb-best';
        best.textContent = formatTime(r.personalBest);

        var avg = document.createElement('span');
        avg.className = 'online-lb-meta online-lb-avg';
        avg.textContent = formatTime(r.averageTime);

        var count = document.createElement('span');
        count.className = 'online-lb-meta online-lb-count';
        count.textContent = (r.totalSolves || 0) + ' solves';

        li.appendChild(rank);
        li.appendChild(nameWrap);
        li.appendChild(best);
        li.appendChild(avg);
        li.appendChild(count);
        ol.appendChild(li);
    });
    box.appendChild(ol);
}

// ---------------------------------------------------------------------------
// Small DOM / formatting helpers
// ---------------------------------------------------------------------------

function emptyNote(text) {
    var p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = text;
    return p;
}

function footnote(text) {
    var p = document.createElement('p');
    p.className = 'panel-footnote';
    p.textContent = text;
    return p;
}

function statusEl(id) {
    var p = document.createElement('p');
    p.id = id;
    p.className = 'online-status';
    p.setAttribute('role', 'status');
    return p;
}

function button(cls, text, handler) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', handler);
    return b;
}

function setStatus(id, message, kind) {
    var el = document.getElementById(id);
    if (!el) {
        return;
    }
    el.textContent = message || '';
    el.className = 'online-status' + (kind ? ' ' + kind : '');
}

function setProfileStatus(message, kind) {
    setStatus('onlineProfileStatus', message, kind);
}

function setFriendsStatus(message, kind) {
    setStatus('onlineFriendsStatus', message, kind);
}

function setProfileBusy(busy) {
    var btn = document.getElementById('onlineCreateBtn');
    if (btn) {
        btn.disabled = busy;
        btn.textContent = busy ? 'Creating…' : 'Create Profile';
    }
}

function setFriendsBusy(busy) {
    var btn = document.getElementById('onlineAddBtn');
    if (btn) {
        btn.disabled = busy;
        btn.textContent = busy ? 'Adding…' : 'Add';
    }
}

function setDeleteBusy(busy) {
    var btn = document.querySelector('.online-btn.danger');
    if (btn) {
        btn.disabled = busy;
        btn.textContent = busy ? 'Deleting…' : 'Delete Account';
        btn.classList.remove('danger-armed');
    }
}

function formatTime(ms) {
    if (ms == null || isNaN(ms)) {
        return '—';
    }
    var totalSec = ms / 1000;
    if (ms < 60000) {
        return totalSec.toFixed(2) + 's';
    }
    var m = Math.floor(totalSec / 60);
    return m + 'm ' + (totalSec - m * 60).toFixed(2) + 's';
}

function formatDuration(ms) {
    var sec = Math.round(ms / 1000);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (h > 0) {
        return h + 'h ' + m + 'm';
    }
    if (m > 0) {
        return m + 'm ' + String(s).padStart(2, '0') + 's';
    }
    return s + 's';
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

init();
