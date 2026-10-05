// ============================================================
// POSTING TRACKER (v1.78.0)
//
// Remembers the id of every ledger row (transactions) posted while one
// request runs, so a form can connect documents to ALL the rows it
// created — e.g. a contribution that also posts a side-fund portion
// and a savings portion gets the receipt connected to each of them.
//
// trackPostings is an Express middleware placed just before a
// controller; postTransaction() calls note(id). For an entry that was
// held for approval and is being replayed by the Treasurer, the ids
// come from the approval context instead (moneyApprovalContext), which
// postTransaction already fills.
//
// Node's AsyncLocalStorage keeps the list attached to that one
// request's chain of async calls only — other requests never see it.
// ============================================================

const { AsyncLocalStorage } = require('async_hooks');
const moneyApprovalContext = require('./moneyApprovalContext');

const store = new AsyncLocalStorage();

const trackPostings = (req, res, next) => store.run([], () => next());

const note = (transactionId) => {
    const list = store.getStore();
    if (list && transactionId && !list.includes(transactionId)) list.push(transactionId);
};

// Every ledger row posted so far in this request (or in this approval replay).
const postedIds = () => {
    const own = store.getStore();
    if (own && own.length) return [...own];
    const approval = moneyApprovalContext.get();
    return approval && Array.isArray(approval.postedIds) ? [...approval.postedIds] : [];
};

module.exports = { trackPostings, note, postedIds };
