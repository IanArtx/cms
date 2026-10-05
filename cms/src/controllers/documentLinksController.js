// ============================================================
// TRANSACTION ↔ DOCUMENT LINKS CONTROLLER (v1.78.0)
// See services/documentLinksService.js for the rules.
//
//   GET    /api/transactions/:id/documents                documents connected to a transaction
//   POST   /api/transactions/:id/documents                { document_ids[], confirm_additional?, note? }
//   DELETE /api/transactions/:id/documents/:documentId    disconnect
//   GET    /api/documents/:id/transactions                transactions connected to a document
//   POST   /api/documents/:id/transactions                { transaction_ids[], confirm_additional?, note? }
//   DELETE /api/documents/:id/transactions/:transactionId disconnect
//
// A POST answers 409 { error: 'ALREADY_CONNECTED', details } when the
// transaction or document already has a connection and
// confirm_additional is not true — the screen asks, then sends again.
// ============================================================

const { withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');
const links = require('../services/documentLinksService');

const getTransactionDocuments = asyncHandler(async (req, res) => {
    sendSuccess(res, await links.listDocumentsForTransaction(parseInt(req.params.id, 10), req.user));
});

const linkTransactionDocuments = asyncHandler(async (req, res) => {
    const transactionId = parseInt(req.params.id, 10);
    const documentIds = links.cleanIds(req.body.document_ids);
    if (!documentIds.length) throw createError.badRequest('Choose at least one document to connect.');
    const out = await withTransaction(client => links.link(client, {
        transactionIds: [transactionId], documentIds, userId: req.user.id, via: 'LATER',
        confirmAdditional: req.body.confirm_additional === true || req.body.confirm_additional === 'true',
        note: req.body.note, ipAddress: req.ip,
    }));
    sendSuccess(res, {
        ...out,
        documents: await links.listDocumentsForTransaction(transactionId, req.user),
    }, out.created ? `Connected ${out.created} document(s).` : 'Those documents were already connected.');
});

const unlinkTransactionDocument = asyncHandler(async (req, res) => {
    const transactionId = parseInt(req.params.id, 10);
    await withTransaction(client => links.unlink(client, {
        transactionId, documentId: parseInt(req.params.documentId, 10), userId: req.user.id, ipAddress: req.ip,
    }));
    sendSuccess(res, { documents: await links.listDocumentsForTransaction(transactionId, req.user) }, 'Document disconnected.');
});

const getDocumentTransactions = asyncHandler(async (req, res) => {
    await links.assertCanSeeDocument(req.user, parseInt(req.params.id, 10));
    sendSuccess(res, await links.listTransactionsForDocument(parseInt(req.params.id, 10), req.user));
});

const linkDocumentTransactions = asyncHandler(async (req, res) => {
    if (!links.hasFinancialAccess(req.user)) throw createError.forbidden('Your role does not have access to company financial data.');
    const documentId = parseInt(req.params.id, 10);
    await links.assertCanSeeDocument(req.user, documentId);
    const transactionIds = links.cleanIds(req.body.transaction_ids);
    if (!transactionIds.length) throw createError.badRequest('Choose at least one transaction to connect.');
    const out = await withTransaction(client => links.link(client, {
        transactionIds, documentIds: [documentId], userId: req.user.id, via: 'LATER',
        confirmAdditional: req.body.confirm_additional === true || req.body.confirm_additional === 'true',
        note: req.body.note, ipAddress: req.ip,
    }));
    sendSuccess(res, { ...out, ...(await links.listTransactionsForDocument(documentId, req.user)) },
        out.created ? `Connected ${out.created} transaction(s).` : 'Those transactions were already connected.');
});

const unlinkDocumentTransaction = asyncHandler(async (req, res) => {
    if (!links.hasFinancialAccess(req.user)) throw createError.forbidden('Your role does not have access to company financial data.');
    const documentId = parseInt(req.params.id, 10);
    await withTransaction(client => links.unlink(client, {
        transactionId: parseInt(req.params.transactionId, 10), documentId, userId: req.user.id, ipAddress: req.ip,
    }));
    sendSuccess(res, await links.listTransactionsForDocument(documentId, req.user), 'Transaction disconnected.');
});

module.exports = {
    getTransactionDocuments, linkTransactionDocuments, unlinkTransactionDocument,
    getDocumentTransactions, linkDocumentTransactions, unlinkDocumentTransaction,
};
