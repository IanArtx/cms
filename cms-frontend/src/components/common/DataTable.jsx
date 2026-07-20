// ============================================================
// DATA TABLE
// Reusable table component used across all list pages.
// Handles loading states, empty states, and pagination.
// ============================================================

import { useState } from 'react';
import LoadingSpinner from './LoadingSpinner';
import { ChevronLeftIcon, ChevronRightIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';

// ============================================================
// Search a row's own values (not the rendered JSX) — works
// automatically for any column set without per-page config.
// ============================================================
const rowMatches = (row, term) => {
    const haystack = Object.values(row)
        .map(v => (v === null || v === undefined) ? '' : String(v))
        .join(' ')
        .toLowerCase();
    return haystack.includes(term);
};

const DataTable = ({
    columns,
    data,
    loading = false,
    emptyMessage = 'No records found',
    pagination = null,
    onPageChange = null,
    // Set searchable to add a filter box above the table. Filters only
    // the rows already loaded/shown on this page (no new backend calls) —
    // fine for most lists here since they're already scoped by tab/period.
    searchable = false,
    searchPlaceholder = 'Search this list...',
}) => {
    const [searchTerm, setSearchTerm] = useState('');

    const filteredData = (searchable && searchTerm.trim())
        ? data.filter(row => rowMatches(row, searchTerm.trim().toLowerCase()))
        : data;

    if (loading) {
        return (
            <div className="card flex items-center justify-center py-12">
                <LoadingSpinner size="md" text="Loading..." />
            </div>
        );
    }

    return (
        <div className="card p-0 overflow-hidden w-full min-w-0">
            {searchable && (
                <div className="px-4 py-3 border-b border-gray-200">
                    <div className="relative max-w-xs">
                        <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2
                            h-4 w-4 text-gray-400 pointer-events-none" />
                        <input
                            type="text"
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            placeholder={searchPlaceholder}
                            className="input pl-9 text-sm w-full"
                        />
                    </div>
                </div>
            )}
            <div className="overflow-x-auto max-w-full">
                <table className="min-w-full divide-y divide-gray-200">
                    {/* Table Header */}
                    <thead className="bg-gray-50">
                        <tr>
                            {columns.map((col, i) => (
                                <th
                                    key={i}
                                    className="table-header"
                                    style={{ width: col.width || 'auto' }}
                                >
                                    {col.header}
                                </th>
                            ))}
                        </tr>
                    </thead>

                    {/* Table Body */}
                    <tbody className="bg-white divide-y divide-gray-200">
                        {filteredData.length === 0 ? (
                            <tr>
                                <td
                                    colSpan={columns.length}
                                    className="px-6 py-12 text-center text-sm text-gray-500"
                                >
                                    {searchable && searchTerm.trim()
                                        ? 'No matching records on this page'
                                        : emptyMessage}
                                </td>
                            </tr>
                        ) : (
                            filteredData.map((row, rowIndex) => (
                                <tr
                                    key={rowIndex}
                                    className="hover:bg-gray-50 transition-colors"
                                >
                                    {columns.map((col, colIndex) => (
                                        <td
                                            key={colIndex}
                                            className="table-cell"
                                        >
                                            {col.render
                                                ? col.render(row)
                                                : row[col.accessor] || '—'
                                            }
                                        </td>
                                    ))}
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>

            {/* Pagination */}
            {pagination && pagination.totalPages > 1 && (
                <div className="px-6 py-4 border-t border-gray-200 flex items-center
                    justify-between bg-gray-50">
                    <p className="text-sm text-gray-500">
                        Showing page <span className="font-medium">{pagination.page}</span> of{' '}
                        <span className="font-medium">{pagination.totalPages}</span>
                        {' '}({pagination.total} total records)
                    </p>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => onPageChange(pagination.page - 1)}
                            disabled={!pagination.hasPrevPage}
                            className="p-2 rounded-lg border border-gray-300 bg-white
                                text-gray-500 hover:bg-gray-50 disabled:opacity-50
                                disabled:cursor-not-allowed transition-colors"
                        >
                            <ChevronLeftIcon className="h-4 w-4" />
                        </button>
                        <button
                            onClick={() => onPageChange(pagination.page + 1)}
                            disabled={!pagination.hasNextPage}
                            className="p-2 rounded-lg border border-gray-300 bg-white
                                text-gray-500 hover:bg-gray-50 disabled:opacity-50
                                disabled:cursor-not-allowed transition-colors"
                        >
                            <ChevronRightIcon className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default DataTable;