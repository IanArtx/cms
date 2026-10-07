// ============================================================
// DOCUMENT LIBRARY TILES (v1.81.0)
// Requested: "the documents page is organised and documents are arranged
// under tiles that match their categories therefore having a dedicated
// page for each category". Confirmed: every top-level document category
// gets a tile (Financial, Corporate, Legal, Agreements, Share Purchase
// Receipts, Statutory Records, Tax Documents and any added later);
// sub-categories appear as tiles on their category's page; the Company
// Archive, documents awaiting my signature and my own documents have
// their own tiles.
//
// Counts come from GET /documents/category-summary, which uses exactly
// the same visibility rules as the lists, so a tile never promises a
// document the person can't open. Archived documents are counted in the
// archive tile, not in their category.
// ============================================================

import { useNavigate } from 'react-router-dom';
import {
    FolderIcon, BanknotesIcon, BuildingOffice2Icon, ScaleIcon, DocumentCheckIcon, ReceiptPercentIcon,
    BuildingLibraryIcon, CalculatorIcon, ShieldCheckIcon, PencilSquareIcon, UserIcon, QueueListIcon,
    ChevronRightIcon, ClipboardDocumentListIcon,
} from '@heroicons/react/24/outline';
import { formatDate } from '../../utils/helpers';

// A fitting picture for the usual categories; anything else is a folder.
const iconFor = (c) => {
    const n = `${c.name} ${c.full_abbreviation || ''}`.toLowerCase();
    if (/financ|\bfin\b/.test(n)) return BanknotesIcon;
    if (/corporat|\bcorp\b/.test(n)) return BuildingOffice2Icon;
    if (/legal|\bleg\b/.test(n)) return ScaleIcon;
    if (/agreement|contract|\bagr\b/.test(n)) return DocumentCheckIcon;
    if (/receipt/.test(n)) return ReceiptPercentIcon;
    if (/statutory|resolution|minute|meeting/.test(n)) return BuildingLibraryIcon;
    if (/tax/.test(n)) return CalculatorIcon;
    if (/requisition/.test(n)) return ClipboardDocumentListIcon;
    return FolderIcon;
};

const Tile = ({ icon: Icon, title, count, countLabel = 'documents', lines = [], onClick, tone = 'primary', badge = null }) => {
    const tones = {
        primary: 'bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300',
        amber: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
        slate: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200',
        green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    };
    return (
        <button type="button" onClick={onClick}
            className="group text-left card !p-4 hover:shadow-md hover:border-primary-200 border border-transparent transition-all focus:outline-none focus:ring-2 focus:ring-primary-500">
            <div className="flex items-start gap-3">
                <span className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${tones[tone]}`}>
                    <Icon className="h-6 w-6" />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-snug">{title}</p>
                    <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 tabular-nums mt-1">
                        {count}<span className="text-xs font-medium text-gray-400 ml-1.5">{countLabel}</span>
                    </p>
                    {lines.filter(Boolean).map((l, i) => <p key={i} className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{l}</p>)}
                </div>
                <ChevronRightIcon className="h-4 w-4 text-gray-300 group-hover:text-primary-500 flex-shrink-0 mt-1" />
            </div>
            {badge && <p className="mt-2 text-[11px] font-semibold text-amber-700 bg-amber-50 rounded px-2 py-0.5 inline-block">{badge}</p>}
        </button>
    );
};

// Tiles for the categories directly under `parentId` (null = top level).
export const CategoryTiles = ({ categories, parentId = null, emptyText = null }) => {
    const navigate = useNavigate();
    const list = categories.filter(c => (c.parent_id || null) === (parentId || null));
    if (!list.length) return emptyText ? <p className="text-sm text-gray-400">{emptyText}</p> : null;
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {list.map(c => (
                <Tile key={c.id} icon={iconFor(c)} title={c.name} count={c.total_count}
                    countLabel={c.total_count === 1 ? 'document' : 'documents'}
                    lines={[
                        c.children?.length ? `${c.children.length} sub-categor${c.children.length === 1 ? 'y' : 'ies'}` : null,
                        c.last_added ? `Latest added ${formatDate(c.last_added)}` : 'Nothing filed yet',
                    ]}
                    badge={c.drafts ? `${c.drafts} draft${c.drafts === 1 ? '' : 's'} here` : null}
                    onClick={() => navigate(`/documents/category/${c.id}`)} />
            ))}
        </div>
    );
};

// The Documents home page: categories, then the other places.
export const LibraryHome = ({ summary, pendingCount, isTreasury, onOpenTab }) => {
    if (!summary) return <p className="text-sm text-gray-400 py-6 text-center">Loading the library…</p>;
    return (
        <div className="space-y-6">
            <section>
                <div className="flex items-baseline justify-between gap-3 mb-3">
                    <h2 className="section-title mb-0">Categories</h2>
                    <p className="text-xs text-gray-400">{summary.total} document{summary.total === 1 ? '' : 's'} filed · archived ones are in the Company Archive</p>
                </div>
                <CategoryTiles categories={summary.categories} emptyText="No document categories yet — an Admin adds them in Settings › Categories." />
            </section>
            <section>
                <h2 className="section-title mb-3">Other places</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                    <Tile icon={ShieldCheckIcon} tone="slate" title="Company Archive" count={summary.archive_count}
                        lines={['Foundational and archived documents']} onClick={() => onOpenTab('archive')} />
                    <Tile icon={PencilSquareIcon} tone="amber" title="Awaiting my signature" count={pendingCount}
                        countLabel={pendingCount === 1 ? 'item' : 'items'} lines={['Documents and share certificates']}
                        onClick={() => onOpenTab('pending-signatures')} />
                    <Tile icon={UserIcon} tone="green" title="My documents" count="—" countLabel=""
                        lines={['Your own share purchase receipts']} onClick={() => onOpenTab('my-documents')} />
                    <Tile icon={QueueListIcon} title="All documents" count={summary.total}
                        lines={['One list, every category, with filters']} onClick={() => onOpenTab('documents')} />
                    {isTreasury && (
                        <Tile icon={ReceiptPercentIcon} tone="slate" title="Shareholding receipts" count="—" countLabel=""
                            lines={["Every member's share purchase receipts"]} onClick={() => onOpenTab('shareholding-receipts')} />
                    )}
                </div>
            </section>
        </div>
    );
};

// "Documents › Statutory Records › Resolutions" for a category page.
export const categoryChain = (categories, id) => {
    const byId = new Map(categories.map(c => [c.id, c]));
    const chain = [];
    let cur = byId.get(id);
    const seen = new Set();
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); chain.unshift(cur); cur = cur.parent_id ? byId.get(cur.parent_id) : null; }
    return chain;
};
