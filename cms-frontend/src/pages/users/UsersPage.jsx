// ============================================================
// USERS / MEMBERS PAGE
// Shows all system members with role management.
// Admin can assign and remove individual roles.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { usersAPI } from '../../api/endpoints';
import { formatDate, formatRelativeTime, getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import ErrorMessage from '../../components/common/ErrorMessage';
import StatusBadge from '../../components/common/StatusBadge';
import Avatar from '../../components/common/Avatar';
import { useAuth } from '../../contexts/AuthContext';
import { UserPlusIcon, CheckIcon, XMarkIcon } from '@heroicons/react/24/outline';

// ============================================================
// ASSIGN ROLE MODAL
// ============================================================
const AssignRoleModal = ({ isOpen, user, onClose, onSuccess, roles }) => {
    const [roleId,  setRoleId]  = useState('');
    const [notes,   setNotes]   = useState('');
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);

    if (!isOpen || !user) return null;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await usersAPI.assignRole(user.id, {
                role_id: parseInt(roleId),
                notes:   notes || undefined,
            });
            onSuccess();
            onClose();
            setRoleId('');
            setNotes('');
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const userRoleIds = (user.roles || []).map(r =>
        typeof r === 'object' ? r.id : r
    );
    const availableRoles = roles.filter(r => !userRoleIds.includes(r.id));

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl
                    max-w-md w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        Assign Role
                    </h2>
                    <p className="text-sm text-gray-500 mb-4">
                        {user.first_name} {user.last_name}
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error}
                                onDismiss={() => setError(null)} />
                        </div>
                    )}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="label">Role *</label>
                            <select className="input" value={roleId}
                                onChange={e => setRoleId(e.target.value)} required>
                                <option value="">Select role...</option>
                                {availableRoles.map(r => (
                                    <option key={r.id} value={r.id}>{r.name}</option>
                                ))}
                            </select>
                            {availableRoles.length === 0 && (
                                <p className="text-xs text-gray-400 mt-1">
                                    This member already has all available roles.
                                </p>
                            )}
                        </div>
                        <div>
                            <label className="label">Notes</label>
                            <textarea className="input" rows={2} value={notes}
                                onChange={e => setNotes(e.target.value)}
                                placeholder="Reason for assignment..." />
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={onClose}
                                className="btn-secondary">Cancel</button>
                            <button type="submit"
                                disabled={loading || availableRoles.length === 0}
                                className="btn-primary">
                                {loading ? 'Assigning...' : 'Assign Role'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// MANAGE ROLES MODAL
// Shows all current roles with option to remove each
// ============================================================
const ManageRolesModal = ({ isOpen, user, onClose, onSuccess, roles }) => {
    const [loading,    setLoading]    = useState(false);
    const [error,      setError]      = useState(null);
    const [showAssign, setShowAssign] = useState(false);
    const [roleId,     setRoleId]     = useState('');
    const [notes,      setNotes]      = useState('');

    if (!isOpen || !user) return null;

    const currentRoles = (user.roles || []).map(r =>
        typeof r === 'object' ? r : { id: r, name: r }
    );

    const userRoleIds = currentRoles.map(r => r.id);
    const availableRoles = roles.filter(r => !userRoleIds.includes(r.id));

    const handleRemoveRole = async (roleId) => {
        if (!window.confirm('Remove this role from the member?')) return;
        setLoading(true);
        setError(null);
        try {
            await usersAPI.revokeRole(user.id, roleId);
            onSuccess(user.id);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const handleAssignRole = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await usersAPI.assignRole(user.id, {
                role_id: parseInt(roleId),
                notes:   notes || undefined,
            });
            onSuccess(user.id);
            setShowAssign(false);
            setRoleId('');
            setNotes('');
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl
                    max-w-md w-full p-6">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <h2 className="text-lg font-semibold text-gray-900">
                                Manage Roles
                            </h2>
                            <p className="text-sm text-gray-500">
                                {user.first_name} {user.last_name}
                            </p>
                        </div>
                        <button onClick={onClose}
                            className="text-gray-400 hover:text-gray-600">
                            <XMarkIcon className="h-5 w-5" />
                        </button>
                    </div>

                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error}
                                onDismiss={() => setError(null)} />
                        </div>
                    )}

                    {/* Current Roles */}
                    <div className="mb-4">
                        <p className="text-sm font-medium text-gray-700 mb-2">
                            Current Roles
                        </p>
                        {currentRoles.length === 0 ? (
                            <p className="text-sm text-gray-400">No roles assigned</p>
                        ) : (
                            <div className="space-y-2">
                                {currentRoles.map(role => (
                                    <div key={role.id} className="flex items-center
                                        justify-between p-2 bg-gray-50 rounded-lg">
                                        <span className="text-sm font-medium
                                            text-gray-900">
                                            {role.name}
                                        </span>
                                        <button
                                            onClick={() => handleRemoveRole(role.id)}
                                            disabled={loading}
                                            className="p-1 rounded-lg bg-red-50
                                                text-red-500 hover:bg-red-100
                                                transition-colors"
                                            title={`Remove ${role.name} role`}
                                        >
                                            <XMarkIcon className="h-4 w-4" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Assign New Role */}
                    {!showAssign ? (
                        <button
                            onClick={() => setShowAssign(true)}
                            disabled={availableRoles.length === 0}
                            className="btn-secondary w-full text-sm"
                        >
                            {availableRoles.length === 0
                                ? 'All roles assigned'
                                : '+ Assign Additional Role'
                            }
                        </button>
                    ) : (
                        <form onSubmit={handleAssignRole} className="border-t
                            border-gray-200 pt-4 mt-4 space-y-3">
                            <p className="text-sm font-medium text-gray-700">
                                Assign New Role
                            </p>
                            <select className="input" value={roleId}
                                onChange={e => setRoleId(e.target.value)} required>
                                <option value="">Select role...</option>
                                {availableRoles.map(r => (
                                    <option key={r.id} value={r.id}>{r.name}</option>
                                ))}
                            </select>
                            <textarea className="input" rows={2} value={notes}
                                onChange={e => setNotes(e.target.value)}
                                placeholder="Reason for assignment..." />
                            <div className="flex gap-2">
                                <button type="button"
                                    onClick={() => setShowAssign(false)}
                                    className="btn-secondary flex-1 text-sm">
                                    Cancel
                                </button>
                                <button type="submit" disabled={loading}
                                    className="btn-primary flex-1 text-sm">
                                    {loading ? 'Assigning...' : 'Assign Role'}
                                </button>
                            </div>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
};

// ============================================================
// ROLE REQUESTS TAB
// ============================================================
const RoleRequestsTab = ({ requests, onApprove, loading }) => (
    <div className="card">
        <h3 className="section-title mb-4">Pending Role Requests</h3>
        {requests.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">
                No pending role requests
            </p>
        ) : (
            <div className="space-y-3">
                {requests.map(req => (
                    <div key={req.id} className="flex items-start justify-between
                        p-4 bg-gray-50 rounded-lg">
                        <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                                <p className="text-sm font-medium text-gray-900">
                                    {req.user?.first_name} {req.user?.last_name}
                                </p>
                                <span className="text-xs text-gray-400">
                                    {req.user?.email}
                                </span>
                            </div>
                            <p className="text-sm text-gray-600">
                                Requesting:{' '}
                                <span className="font-medium text-primary-700">
                                    {req.role?.name}
                                </span>
                            </p>
                            {req.reason && (
                                <p className="text-xs text-gray-500 mt-1">
                                    {req.reason}
                                </p>
                            )}
                            <p className="text-xs text-gray-400 mt-1">
                                {formatRelativeTime(req.created_at)}
                            </p>
                        </div>
                        <div className="flex gap-2 ml-4">
                            <button
                                onClick={() => onApprove(req.user?.id, req.role?.id)}
                                disabled={loading}
                                className="p-1.5 rounded-lg bg-green-50 text-green-600
                                    hover:bg-green-100 transition-colors"
                                title="Approve"
                            >
                                <CheckIcon className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        )}
    </div>
);

// ============================================================
// MAIN USERS PAGE
// ============================================================
// ============================================================
// DELETE PERMANENTLY MODAL (v1.35.0)
// For duplicate/unused registrations only -- irreversible, and only
// possible at all if the account has no activity anywhere in the
// system. Runs the read-only deletion-check the moment it opens;
// the confirm button only appears once that check comes back clean.
// See userDeletionService.js for the full explanation of why this
// can't just be a plain "delete user" button.
// ============================================================
const DeletePermanentlyModal = ({ isOpen, user, onClose, onSuccess }) => {
    const [footprint, setFootprint] = useState(null);
    const [checking,  setChecking]  = useState(false);
    const [deleting,  setDeleting]  = useState(false);
    const [error,     setError]     = useState(null);

    useEffect(() => {
        if (!isOpen || !user) return;
        setFootprint(null);
        setError(null);
        setChecking(true);
        usersAPI.getDeletionCheck(user.id)
            .then(res => setFootprint(res.data.data))
            .catch(err => setError(getErrorMessage(err)))
            .finally(() => setChecking(false));
    }, [isOpen, user]);

    if (!isOpen || !user) return null;

    const handleDelete = async () => {
        setDeleting(true);
        setError(null);
        try {
            await usersAPI.deleteUserPermanently(user.id);
            onSuccess();
            onClose();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setDeleting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        Delete Permanently
                    </h2>
                    <p className="text-sm text-gray-500 mb-4">
                        {user.first_name} {user.last_name} ({user.email})
                    </p>

                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}

                    {checking ? (
                        <div className="py-8 text-center text-sm text-gray-400">
                            Checking for account activity...
                        </div>
                    ) : footprint && !footprint.clean ? (
                        <div>
                            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
                                <p className="text-sm text-red-800 font-medium mb-1">
                                    Cannot be deleted -- this account has real activity on record:
                                </p>
                                <ul className="text-xs text-red-700 list-disc list-inside space-y-0.5">
                                    {footprint.blocking.map(b => (
                                        <li key={`${b.table}.${b.column}`}>
                                            {b.table}.{b.column} ({b.count} row{b.count === 1 ? '' : 's'})
                                        </li>
                                    ))}
                                </ul>
                            </div>
                            <p className="text-sm text-gray-500">
                                Use <strong>Deactivate</strong> instead -- it blocks login without
                                touching any of this member's financial or historical records.
                            </p>
                        </div>
                    ) : footprint && footprint.clean ? (
                        <div>
                            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
                                <p className="text-sm text-amber-800">
                                    No activity found -- this account is safe to delete. This
                                    permanently removes the account and cannot be undone.
                                </p>
                            </div>
                        </div>
                    ) : null}

                    <div className="flex justify-end gap-3 pt-2">
                        <button type="button" onClick={onClose} className="btn-secondary">
                            Cancel
                        </button>
                        {footprint?.clean && (
                            <button type="button" onClick={handleDelete}
                                disabled={deleting}
                                className="btn-danger">
                                {deleting ? 'Deleting...' : 'Delete Permanently'}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

const UsersPage = () => {
    const { hasPermission, user } = useAuth();
    const [users,        setUsers]        = useState([]);
    const [roles,        setRoles]        = useState([]);
    const [roleRequests, setRoleRequests] = useState([]);
    const [pagination,   setPagination]   = useState(null);
    const [loading,      setLoading]      = useState(true);
    const [error,        setError]        = useState(null);
    const [page,         setPage]         = useState(1);
    const [activeTab,    setActiveTab]    = useState('members');
    const [manageUser,   setManageUser]   = useState(null);
    const [deletingUser, setDeletingUser] = useState(null);
    const [search,       setSearch]       = useState('');
    const [actionLoading, setActionLoading] = useState(false);

    const loadUsers = useCallback(async () => {
        try {
            setLoading(true);
            const params = { page, limit: 20 };
            if (search) params.search = search;
            const res = await usersAPI.getAllUsers(params);
            setUsers(res.data.data);
            setPagination(res.data.meta?.pagination);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [page, search]);

    const loadRoleRequests = useCallback(async () => {
        try {
            const res = await usersAPI.getRoleRequests({ status: 'PENDING' });
            setRoleRequests(res.data.data || []);
        } catch {
            setRoleRequests([]);
        }
    }, []);

    useEffect(() => {
        loadUsers();
        usersAPI.getAllRoles().then(r => setRoles(r.data.data)).catch(() => {});
        if (hasPermission('ROLE_ASSIGN')) loadRoleRequests();
    }, [loadUsers, loadRoleRequests, hasPermission]);

    // Reload single user after role change
    const handleRoleChange = async (userId) => {
        await loadUsers();
        // Refresh the manage user modal with updated data
        if (manageUser && manageUser.id === userId) {
            try {
                const res = await usersAPI.getUserById(userId);
                setManageUser(res.data.data);
            } catch {}
        }
    };

    const handleApproveRequest = async (userId, roleId) => {
        setActionLoading(true);
        try {
            await usersAPI.assignRole(userId, { role_id: roleId });
            loadUsers();
            loadRoleRequests();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setActionLoading(false);
        }
    };

    const handleDeactivate = async (id) => {
        if (!window.confirm('Deactivate this user account?')) return;
        try {
            await usersAPI.deactivateUser(id);
            loadUsers();
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    const columns = [
        {
            header: 'Member',
            render: row => (
                <div className="flex items-center gap-3">
                    <Avatar user={row} size={36} />
                    <div>
                        <p className="text-sm font-medium text-gray-900">
                            {row.first_name} {row.last_name}
                        </p>
                        <p className="text-xs text-gray-400">{row.email}</p>
                    </div>
                </div>
            ),
        },
        {
            header: 'Roles',
            render: row => (
                <div className="flex flex-wrap gap-1">
                    {(row.roles || []).map((role, i) => (
                        <span key={i} className="badge-blue">
                            {typeof role === 'object' ? role.name : role}
                        </span>
                    ))}
                    {(!row.roles || row.roles.length === 0) && (
                        <span className="badge-gray">No roles</span>
                    )}
                </div>
            ),
        },
        {
            header: 'Status',
            render: row => (
                <div className="flex gap-2">
                    <StatusBadge
                        status={row.is_active ? 'ACTIVE' : 'CANCELLED'}
                        label={row.is_active ? 'Active' : 'Inactive'}
                    />
                    {!row.is_email_verified && (
                        <span className="badge-yellow">Unverified</span>
                    )}
                </div>
            ),
        },
        {
            header: 'Last Login',
            render: row => (
                <span className="text-sm text-gray-500">
                    {row.last_login_at
                        ? formatRelativeTime(row.last_login_at)
                        : 'Never'
                    }
                </span>
            ),
        },
        {
            header: 'Joined',
            render: row => (
                <span className="text-sm text-gray-500">
                    {formatDate(row.created_at)}
                </span>
            ),
        },
        {
            header: 'Actions',
            render: row => (
                <div className="flex gap-2">
                    {hasPermission('USER_VIEW_ALL') && (
                        <Link
                            to={`/users/${row.id}/portfolio`}
                            className="text-xs text-gray-600 hover:text-gray-800
                                font-medium px-2 py-1 rounded border border-gray-200
                                hover:bg-gray-50 transition-colors"
                        >
                            View Portfolio
                        </Link>
                    )}
                    {hasPermission('ROLE_ASSIGN') && (
                        <button
                            onClick={() => setManageUser(row)}
                            className="text-xs text-primary-600 hover:text-primary-700
                                font-medium px-2 py-1 rounded border border-primary-200
                                hover:bg-primary-50 transition-colors"
                        >
                            Manage Roles
                        </button>
                    )}
                    {hasPermission('USER_MANAGE') && row.is_active && (
                        <button
                            onClick={() => handleDeactivate(row.id)}
                            className="text-xs text-red-600 hover:text-red-700
                                font-medium px-2 py-1 rounded border border-red-200
                                hover:bg-red-50 transition-colors"
                        >
                            Deactivate
                        </button>
                    )}
                    {hasPermission('USER_MANAGE') && row.id !== user?.id && (
                        <button
                            onClick={() => setDeletingUser(row)}
                            className="text-xs text-gray-500 hover:text-red-700
                                font-medium px-2 py-1 rounded border border-gray-200
                                hover:border-red-200 hover:bg-red-50 transition-colors"
                            title="Only possible if this account has no activity on record"
                        >
                            Delete Permanently
                        </button>
                    )}
                </div>
            ),
        },
    ];

    return (
        <div>
            <PageHeader
                title="Members"
                subtitle="All system members, roles and access management"
            />

            {error && (
                <div className="mb-4">
                    <ErrorMessage message={error} onDismiss={() => setError(null)} />
                </div>
            )}

            {/* Tabs — overflow-x-auto (v1.32.5) for consistency with every
                other tabbed page, though only two tabs live here today. */}
            <div className="flex gap-2 mb-6 overflow-x-auto scrollbar-hidden pb-1">
                {['members', 'requests'].map(tab => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`px-4 py-2 rounded-lg text-sm font-medium
                            transition-colors capitalize ${activeTab === tab
                                ? 'bg-primary-700 text-white'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                            }`}
                    >
                        {tab === 'requests'
                            ? `Role Requests ${roleRequests.length > 0
                                ? `(${roleRequests.length})` : ''}`
                            : 'Members'
                        }
                    </button>
                ))}
            </div>

            {activeTab === 'members' && (
                <>
                    {/* Search */}
                    <div className="card mb-6">
                        <input
                            type="text"
                            className="input"
                            placeholder="Search by name or email..."
                            value={search}
                            onChange={e => {
                                setSearch(e.target.value);
                                setPage(1);
                            }}
                        />
                    </div>

                    <DataTable
                        columns={columns}
                        data={users}
                        loading={loading}
                        emptyMessage="No members found"
                        searchable
                        searchPlaceholder="Search members..."
                        pagination={pagination}
                        onPageChange={setPage}
                    />
                </>
            )}

            {activeTab === 'requests' && hasPermission('ROLE_ASSIGN') && (
                <RoleRequestsTab
                    requests={roleRequests}
                    onApprove={handleApproveRequest}
                    loading={actionLoading}
                />
            )}

            {/* Manage Roles Modal */}
            <ManageRolesModal
                isOpen={!!manageUser}
                user={manageUser}
                onClose={() => setManageUser(null)}
                onSuccess={handleRoleChange}
                roles={roles}
            />

            {/* Delete Permanently Modal (v1.35.0) */}
            <DeletePermanentlyModal
                isOpen={!!deletingUser}
                user={deletingUser}
                onClose={() => setDeletingUser(null)}
                onSuccess={loadUsers}
            />
        </div>
    );
};

export default UsersPage;