// ============================================================
// MONEY APPROVAL CONTEXT (v1.73.0)
//
// When the Treasurer or an Admin approves a money entry that was held
// for approval (see middleware/holdMoneyEntry.js), the original action
// is run again on behalf of the person who recorded it. While it runs,
// this context carries:
//   • approvedBy  — the approver's user id, so every ledger row posted
//                   during that run stores approved_by = the approver
//                   (created_by stays the person who recorded it);
//   • postedIds   — the ids of every ledger row posted during the run,
//                   saved on the held entry so it can be traced.
//
// Node's AsyncLocalStorage keeps the value attached to that one
// request's chain of async calls only — other requests running at the
// same time never see it.
// ============================================================

const { AsyncLocalStorage } = require('async_hooks');

const store = new AsyncLocalStorage();

const run = (ctx, fn) => store.run(ctx, fn);
const get = () => store.getStore() || null;

module.exports = { run, get };
