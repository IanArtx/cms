// ============================================================
// useFormDraft — keep a form's unfinished input (v1.81.0)
//
// Requested: "as one fills the forms / templates … the system can recall
// where they left off … sudden refresh, loss of internet or any other
// reason … if one is writing minutes and they press the back button or
// click a button in the UI unintentionally".
// Confirmed: kept on this device as you type AND on the server every few
// seconds (so it also survives automatic sign-out and a change of device).
//
//   const draft = useFormDraft('requisition:new', form, setForm, {
//       enabled: isOpen,                // only while the form is open
//       title: 'New requisition',       // shown in "My unfinished forms"
//       omit: ['files'],                // fields that cannot be kept (files)
//   });
//   <DraftNotice draft={draft} />       // "Picked up where you left off …"
//   … after a successful submit:  draft.clear();
//
// When the form opens and a draft exists, it is put back into the form
// straight away and the notice offers "Start over". Nothing is saved
// while the form still looks exactly as it opened.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { draftsAPI } from '../api/endpoints';
import { DRAFT_PREFIX } from '../utils/draftStore';
const LOCAL_DELAY = 300;     // ms after the last keystroke
const SERVER_DELAY = 2500;   // ms after the last keystroke

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

const clean = (value, omit) => {
    if (!isPlainObject(value) || !omit?.length) return value;
    const out = { ...value };
    omit.forEach(k => { delete out[k]; });
    return out;
};

const readLocal = (storageKey) => {
    try { const raw = localStorage.getItem(storageKey); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
};
const writeLocal = (storageKey, entry) => {
    try { localStorage.setItem(storageKey, JSON.stringify(entry)); return true; } catch (_) { return false; }
};
const removeLocal = (storageKey) => { try { localStorage.removeItem(storageKey); } catch (_) { /* ignore */ } };

const useFormDraft = (key, value, setValue, { enabled = true, title = null, omit = [], page = null } = {}) => {
    const { user } = useAuth();
    const location = useLocation();
    const uid = user?.id;
    const active = !!(enabled && key && uid);
    const storageKey = active ? `${DRAFT_PREFIX}${uid}:${key}` : null;

    const [restored, setRestored] = useState(null);   // { savedAt, where }
    const [status, setStatus] = useState('idle');     // idle | saving | saved | device
    const [savedAt, setSavedAt] = useState(null);

    const valueRef = useRef(value);
    valueRef.current = value;
    const omitRef = useRef(omit);
    omitRef.current = omit;
    const startJson = useRef(null);     // how the form looked when it opened (or was restored / cleared)
    const openValue = useRef(null);     // the form as it opened, before any draft was put back
    const hasDraft = useRef(false);     // a draft exists (restored, or saved since opening)
    const rebasePending = useRef(false); // the next value is the refilled saved record
    const lastLocal = useRef(null);
    const lastServer = useRef(null);
    const readyKey = useRef(null);      // storageKey once loading has finished
    const localTimer = useRef(null);
    const serverTimer = useRef(null);
    const metaRef = useRef({});
    metaRef.current = { title, page: page || `${location.pathname}${location.search}` };

    const json = (v) => JSON.stringify(clean(v, omitRef.current));

    const apply = useCallback((data) => {
        setValue(prev => (isPlainObject(prev) && isPlainObject(data) ? { ...prev, ...data } : data));
    }, [setValue]);

    const pushServer = useCallback(async (k, data) => {
        try {
            const r = await draftsAPI.save(k, { data, title: metaRef.current.title, page: metaRef.current.page });
            lastServer.current = JSON.stringify(data);
            setStatus('saved');
            setSavedAt(r.data?.data?.updated_at || new Date().toISOString());
        } catch (_) {
            setStatus('device'); // kept on this device; tried again when back online
        }
    }, []);

    // ---- open: put back an earlier draft ----------------------------
    useEffect(() => {
        readyKey.current = null;
        setRestored(null);
        setStatus('idle');
        if (!active) return undefined;
        let cancelled = false;
        // Let the form finish its own "reset when opened" first.
        const t = setTimeout(async () => {
            if (cancelled) return;
            startJson.current = json(valueRef.current);
            openValue.current = JSON.parse(startJson.current ?? 'null');
            lastLocal.current = startJson.current;
            lastServer.current = null;
            hasDraft.current = false;
            const local = readLocal(storageKey);
            let best = local?.data ? { data: local.data, savedAt: local.savedAt, where: 'this device' } : null;
            if (best && JSON.stringify(best.data) !== startJson.current) {
                apply(best.data);
                hasDraft.current = true;
                setRestored({ savedAt: best.savedAt, where: best.where });
                startJson.current = JSON.stringify(best.data);
                lastLocal.current = startJson.current;
            } else {
                best = null;
            }
            readyKey.current = storageKey;
            try {
                const r = await draftsAPI.get(key);
                const d = r.data?.data;
                if (cancelled || !d?.data) return;
                lastServer.current = JSON.stringify(d.data);
                const newer = !best || new Date(d.updated_at) > new Date(best.savedAt || 0);
                const untouched = json(valueRef.current) === startJson.current;
                if (newer && untouched && JSON.stringify(d.data) !== startJson.current) {
                    apply(d.data);
                    hasDraft.current = true;
                    setRestored({ savedAt: d.updated_at, where: 'your account' });
                    startJson.current = JSON.stringify(d.data);
                    lastLocal.current = startJson.current;
                    writeLocal(storageKey, { data: d.data, savedAt: d.updated_at, title: metaRef.current.title, page: metaRef.current.page });
                }
            } catch (_) { /* offline — the device copy is enough */ }
        }, 0);
        return () => { cancelled = true; clearTimeout(t); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storageKey]);

    // ---- typing: keep it ---------------------------------------------
    useEffect(() => {
        if (!active || readyKey.current !== storageKey) return undefined;
        const current = json(value);
        if (rebasePending.current) {
            // The form was just refilled from the saved record: new starting point.
            rebasePending.current = false;
            if (!hasDraft.current) { startJson.current = current; lastLocal.current = current; return undefined; }
        }
        if (current === startJson.current && !hasDraft.current) return undefined; // still exactly as opened
        if (current !== lastLocal.current) {
            clearTimeout(localTimer.current);
            localTimer.current = setTimeout(() => {
                if (!hasDraft.current && json(valueRef.current) === startJson.current) return; // back to as opened / just re-based
                if (writeLocal(storageKey, { data: JSON.parse(current), savedAt: new Date().toISOString(), title: metaRef.current.title, page: metaRef.current.page })) {
                    lastLocal.current = current;
                    hasDraft.current = true;
                    setStatus('saving');
                }
            }, LOCAL_DELAY);
        }
        if (current !== lastServer.current) {
            clearTimeout(serverTimer.current);
            serverTimer.current = setTimeout(() => {
                if (!hasDraft.current && json(valueRef.current) === startJson.current) return;
                hasDraft.current = true;
                pushServer(key, JSON.parse(current));
            }, SERVER_DELAY);
        }
        return undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, storageKey]);

    // ---- leaving the page / losing the connection -----------------------
    useEffect(() => {
        if (!active) return undefined;
        const flushLocal = () => {
            if (readyKey.current !== storageKey) return;
            const current = json(valueRef.current);
            if (current !== lastLocal.current && (current !== startJson.current || hasDraft.current)) {
                writeLocal(storageKey, { data: JSON.parse(current), savedAt: new Date().toISOString(), title: metaRef.current.title, page: metaRef.current.page });
                lastLocal.current = current;
            }
            if ((current !== startJson.current || hasDraft.current) && current !== lastServer.current) {
                // Last chance to reach the server as the page closes.
                try {
                    const api = (process.env.REACT_APP_API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
                    fetch(`${api}/drafts/${encodeURIComponent(key)}`, {
                        method: 'PUT', keepalive: true,
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('accessToken') || ''}` },
                        body: JSON.stringify({ data: JSON.parse(current), title: metaRef.current.title, page: metaRef.current.page }),
                    }).catch(() => {});
                } catch (_) { /* ignore */ }
            }
        };
        const onOnline = () => {
            const local = readLocal(storageKey);
            if (local?.data && JSON.stringify(local.data) !== lastServer.current) pushServer(key, local.data);
        };
        window.addEventListener('pagehide', flushLocal);
        window.addEventListener('online', onOnline);
        return () => {
            window.removeEventListener('pagehide', flushLocal);
            window.removeEventListener('online', onOnline);
            // Closing the form (or leaving the page inside the app): keep what was typed.
            clearTimeout(localTimer.current);
            const pendingServer = serverTimer.current;
            clearTimeout(pendingServer);
            if (readyKey.current === storageKey) {
                const current = json(valueRef.current);
                if (current !== startJson.current || hasDraft.current) {
                    if (current !== lastLocal.current) writeLocal(storageKey, { data: JSON.parse(current), savedAt: new Date().toISOString(), title: metaRef.current.title, page: metaRef.current.page });
                    if (current !== lastServer.current) {
                        draftsAPI.save(key, { data: JSON.parse(current), title: metaRef.current.title, page: metaRef.current.page }).catch(() => {});
                    }
                }
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storageKey]);

    // ---- submitted or discarded ----------------------------------------
    const clear = useCallback(() => {
        clearTimeout(localTimer.current);
        clearTimeout(serverTimer.current);
        if (storageKey) removeLocal(storageKey);
        if (key && uid) draftsAPI.remove(key).catch(() => {});
        const current = json(valueRef.current);
        startJson.current = current;
        lastLocal.current = current;
        lastServer.current = null;
        hasDraft.current = false;
        setRestored(null);
        setStatus('idle');
        setSavedAt(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storageKey, key, uid]);

    // "Start over": the form as it was before the draft was put back.
    const startOver = useCallback((blank) => {
        const back = blank !== undefined ? blank : openValue.current;
        clear();
        if (back !== null && back !== undefined) {
            apply(back);
            startJson.current = json(back);
            lastLocal.current = startJson.current;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clear, apply]);

    // The form was refilled from the saved record (e.g. after saving it):
    // that is the new starting point, not something to keep as a draft.
    // Call it right after setting the form from the record; the next value
    // the form takes becomes the starting point.
    const rebase = useCallback(() => { rebasePending.current = true; }, []);
    // Unsaved typing exists (kept as a draft).
    const isDirty = useCallback(() => hasDraft.current, []);

    return { restored, status, savedAt, clear, startOver, rebase, isDirty, active };
};

// A form kept in several pieces of state (e.g. a meeting and its agenda):
//   const [value, setValue] = useDraftFields({ form: [form, setForm], agenda: [agenda, setAgenda] });
//   const draft = useFormDraft('meeting:new', value, setValue, { … });
export const useDraftFields = (fields) => {
    const values = Object.values(fields).map(([v]) => v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const value = useMemo(() => Object.fromEntries(Object.entries(fields).map(([k, [v]]) => [k, v])), values);
    const valueRef = useRef(value);
    valueRef.current = value;
    const fieldsRef = useRef(fields);
    fieldsRef.current = fields;
    const setValue = useCallback((upd) => {
        const next = typeof upd === 'function' ? upd(valueRef.current) : upd;
        if (!next || typeof next !== 'object') return;
        Object.entries(fieldsRef.current).forEach(([k, [, set]]) => { if (k in next) set(next[k]); });
    }, []);
    return [value, setValue];
};

export default useFormDraft;
