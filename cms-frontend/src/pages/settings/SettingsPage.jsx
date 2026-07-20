// ============================================================
// SETTINGS PAGE
// System configuration — currencies, roles, categories.
// Admin only.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { accountsAPI, usersAPI, categoriesAPI, settingsAPI, systemAPI } from '../../api/endpoints';
import { getErrorMessage } from '../../utils/helpers';
import PageHeader from '../../components/common/PageHeader';
import ErrorMessage from '../../components/common/ErrorMessage';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import { useAuth } from '../../contexts/AuthContext';
import { useBranding } from '../../contexts/BrandingContext';
import api from '../../api/axios';
import {
    PlusIcon,
    BanknotesIcon,
    UserGroupIcon,
    TagIcon,
    PencilIcon,
    BuildingOffice2Icon,
    ArrowUpTrayIcon,
    ShieldCheckIcon,
} from '@heroicons/react/24/outline';

// ============================================================
// PERMISSIONS MODAL — grant/revoke permissions for a single role
// ============================================================
const PermissionsModal = ({ isOpen, role, onClose, onSuccess }) => {
    const [allPermissions, setAllPermissions] = useState([]);
    const [granted, setGranted] = useState(new Set());
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen && role) {
            setLoading(true);
            setError(null);
            Promise.all([
                systemAPI.getPermissions(),
                systemAPI.getRolePermissions(role.id),
            ]).then(([permsRes, roleRes]) => {
                setAllPermissions(permsRes.data.data || []);
                setGranted(new Set(roleRes.data.data || []));
            }).catch(err => setError(getErrorMessage(err)))
              .finally(() => setLoading(false));
        }
    }, [isOpen, role]);

    if (!isOpen || !role) return null;

    const byModule = allPermissions.reduce((acc, p) => {
        (acc[p.module] = acc[p.module] || []).push(p);
        return acc;
    }, {});

    const toggle = (code) => {
        setGranted(prev => {
            const next = new Set(prev);
            next.has(code) ? next.delete(code) : next.add(code);
            return next;
        });
    };

    const toggleModule = (module, allChecked) => {
        setGranted(prev => {
            const next = new Set(prev);
            byModule[module].forEach(p => allChecked ? next.delete(p.code) : next.add(p.code));
            return next;
        });
    };

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        try {
            await systemAPI.updateRolePermissions(role.id, Array.from(granted));
            onSuccess?.();
            onClose();
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 bg-black bg-opacity-40" onClick={onClose} />
            <div className="flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-xl shadow-xl max-w-2xl w-full p-6 max-h-[85vh] overflow-y-auto">
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">
                        Permissions — {role.name}
                    </h2>
                    <p className="text-sm text-gray-400 mb-4">
                        Nothing granted here works for anyone until you save. Grouped by module.
                    </p>
                    {error && (
                        <div className="mb-4">
                            <ErrorMessage message={error} onDismiss={() => setError(null)} />
                        </div>
                    )}
                    {loading ? (
                        <LoadingSpinner size="md" text="Loading permissions..." />
                    ) : (
                        <div className="space-y-5">
                            {Object.keys(byModule).sort().map(module => {
                                const perms = byModule[module];
                                const allChecked = perms.every(p => granted.has(p.code));
                                return (
                                    <div key={module} className="border border-gray-100 rounded-lg p-3">
                                        <div className="flex items-center justify-between mb-2">
                                            <h4 className="text-sm font-semibold text-gray-700">{module}</h4>
                                            <button type="button"
                                                onClick={() => toggleModule(module, allChecked)}
                                                className="text-xs text-primary-600 hover:text-primary-700 font-medium">
                                                {allChecked ? 'Clear all' : 'Select all'}
                                            </button>
                                        </div>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                                            {perms.map(p => (
                                                <label key={p.code} className="flex items-start gap-2 text-sm cursor-pointer">
                                                    <input type="checkbox"
                                                        checked={granted.has(p.code)}
                                                        onChange={() => toggle(p.code)}
                                                        className="mt-0.5" />
                                                    <span>
                                                        <span className="text-gray-800 font-mono text-xs">{p.code}</span>
                                                        <span className="block text-xs text-gray-400">{p.description}</span>
                                                    </span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    <div className="flex justify-end gap-3 pt-4 mt-2 border-t border-gray-100">
                        <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                        <button type="button" onClick={handleSave} disabled={saving || loading} className="btn-primary">
                            {saving ? 'Saving...' : 'Save Permissions'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// CURRENCIES TAB
// ============================================================
const CurrenciesTab = () => {
    const [currencies, setCurrencies] = useState([]);
    const [loading,    setLoading]    = useState(true);
    const [error,      setError]      = useState(null);
    const [success,    setSuccess]    = useState(null);
    const [showForm,   setShowForm]   = useState(false);
    const [form, setForm] = useState({ code: '', name: '', symbol: '' });
    const [editingId, setEditingId]   = useState(null);
    const [editForm,  setEditForm]    = useState({ code: '', name: '', symbol: '', is_active: true });

    const load = useCallback(async () => {
        try {
            setLoading(true);
            const res = await accountsAPI.getCurrencies();
            setCurrencies(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError(null);
        setSuccess(null);
        try {
            await accountsAPI.addCurrency(form);
            setSuccess(`Currency ${form.code.toUpperCase()} added successfully`);
            setForm({ code: '', name: '', symbol: '' });
            setShowForm(false);
            load();
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    const startEdit = (c) => {
        setError(null);
        setSuccess(null);
        setEditingId(c.id);
        setEditForm({ code: c.code, name: c.name, symbol: c.symbol || '', is_active: c.is_active !== false });
    };

    const cancelEdit = () => setEditingId(null);

    const handleEditSubmit = async (e, id) => {
        e.preventDefault();
        setError(null);
        setSuccess(null);
        try {
            await accountsAPI.updateCurrency(id, editForm);
            setSuccess(`Currency ${editForm.code.toUpperCase()} updated successfully`);
            setEditingId(null);
            load();
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    if (loading) return <LoadingSpinner size="md" text="Loading currencies..." />;

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">
                    Manage currencies used across all accounts
                </p>
                <button
                    onClick={() => setShowForm(!showForm)}
                    className="btn-primary flex items-center gap-2 text-sm"
                >
                    <PlusIcon className="h-4 w-4" />
                    Add Currency
                </button>
            </div>

            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {success && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700">
                    {success}
                </div>
            )}

            {showForm && (
                <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                    <h4 className="text-sm font-semibold text-gray-700 mb-3">Add New Currency</h4>
                    <form onSubmit={handleSubmit}>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                            <div>
                                <label className="label">Code *</label>
                                <input type="text" className="input" value={form.code}
                                    onChange={e => setForm(p => ({ ...p, code: e.target.value.toUpperCase() }))}
                                    placeholder="e.g. USD" maxLength={10} required />
                            </div>
                            <div>
                                <label className="label">Name *</label>
                                <input type="text" className="input" value={form.name}
                                    onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                                    placeholder="e.g. US Dollar" required />
                            </div>
                            <div>
                                <label className="label">Symbol</label>
                                <input type="text" className="input" value={form.symbol}
                                    onChange={e => setForm(p => ({ ...p, symbol: e.target.value }))}
                                    placeholder="e.g. $" maxLength={10} />
                            </div>
                        </div>
                        <div className="flex justify-end gap-2">
                            <button type="button" onClick={() => setShowForm(false)} className="btn-secondary text-sm">Cancel</button>
                            <button type="submit" className="btn-primary text-sm">Add Currency</button>
                        </div>
                    </form>
                </div>
            )}

            <div className="overflow-hidden rounded-lg border border-gray-200">
                <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="table-header">Code</th>
                            <th className="table-header">Name</th>
                            <th className="table-header">Symbol</th>
                            <th className="table-header">Status</th>
                            <th className="table-header text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {currencies.map(c => (
                            editingId === c.id ? (
                                <tr key={c.id} className="bg-gray-50">
                                    <td className="table-cell" colSpan={5}>
                                        <form onSubmit={(e) => handleEditSubmit(e, c.id)} className="flex flex-wrap items-end gap-3 py-1">
                                            <div>
                                                <label className="label">Code *</label>
                                                <input type="text" className="input" value={editForm.code}
                                                    onChange={e => setEditForm(p => ({ ...p, code: e.target.value.toUpperCase() }))}
                                                    maxLength={10} required />
                                            </div>
                                            <div>
                                                <label className="label">Name *</label>
                                                <input type="text" className="input" value={editForm.name}
                                                    onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))}
                                                    required />
                                            </div>
                                            <div>
                                                <label className="label">Symbol</label>
                                                <input type="text" className="input" value={editForm.symbol}
                                                    onChange={e => setEditForm(p => ({ ...p, symbol: e.target.value }))}
                                                    maxLength={10} />
                                            </div>
                                            <label className="flex items-center gap-2 text-sm text-gray-600 pb-2">
                                                <input type="checkbox" checked={editForm.is_active}
                                                    onChange={e => setEditForm(p => ({ ...p, is_active: e.target.checked }))} />
                                                Active
                                            </label>
                                            <div className="flex gap-2 pb-0.5">
                                                <button type="button" onClick={cancelEdit} className="btn-secondary text-sm">Cancel</button>
                                                <button type="submit" className="btn-primary text-sm">Save</button>
                                            </div>
                                        </form>
                                    </td>
                                </tr>
                            ) : (
                                <tr key={c.id} className="hover:bg-gray-50">
                                    <td className="table-cell font-mono font-bold text-primary-700">{c.code}</td>
                                    <td className="table-cell">{c.name}</td>
                                    <td className="table-cell">{c.symbol || '—'}</td>
                                    <td className="table-cell"><span className="badge-green">Active</span></td>
                                    <td className="table-cell text-right">
                                        <button
                                            onClick={() => startEdit(c)}
                                            className="text-gray-400 hover:text-primary-700 inline-flex items-center gap-1 text-sm"
                                            title="Edit currency"
                                        >
                                            <PencilIcon className="h-4 w-4" />
                                            Edit
                                        </button>
                                    </td>
                                </tr>
                            )
                        ))}
                    </tbody>
                </table>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// ROLES TAB
// ============================================================
const RolesTab = () => {
    const [roles,      setRoles]      = useState([]);
    const [loading,    setLoading]    = useState(true);
    const [error,      setError]      = useState(null);
    const [success,    setSuccess]    = useState(null);
    const [showForm,   setShowForm]   = useState(false);
    const [editRole,   setEditRole]   = useState(null);
    const [permRole,   setPermRole]   = useState(null);
    const [form, setForm] = useState({ name: '', description: '' });

    const load = useCallback(async () => {
        try {
            setLoading(true);
            const res = await usersAPI.getAllRoles();
            setRoles(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const openAdd = () => {
        setEditRole(null);
        setForm({ name: '', description: '' });
        setShowForm(true);
    };

    const openEdit = (role) => {
        if (role.is_system_role) return;
        setEditRole(role);
        setForm({ name: role.name, description: role.description || '' });
        setShowForm(true);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError(null);
        setSuccess(null);
        try {
            if (editRole) {
                await api.patch(`/system/roles/${editRole.id}`, form);
                setSuccess(`Role "${form.name}" updated successfully`);
            } else {
                await api.post('/system/roles', form);
                setSuccess(`Role "${form.name}" added successfully`);
            }
            setForm({ name: '', description: '' });
            setShowForm(false);
            setEditRole(null);
            load();
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    if (loading) return <LoadingSpinner size="md" text="Loading roles..." />;

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">
                    Manage system roles and what each one can do. System roles' names can't be
                    changed, but their permissions can — click the shield icon on any role.
                </p>
                <button onClick={openAdd} className="btn-primary flex items-center gap-2 text-sm">
                    <PlusIcon className="h-4 w-4" />
                    Add Role
                </button>
            </div>

            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {success && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700">
                    {success}
                </div>
            )}

            {showForm && (
                <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                    <h4 className="text-sm font-semibold text-gray-700 mb-3">
                        {editRole ? `Edit Role: ${editRole.name}` : 'Add New Role'}
                    </h4>
                    <form onSubmit={handleSubmit}>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                            <div>
                                <label className="label">Role Name *</label>
                                <input type="text" className="input" value={form.name}
                                    onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                                    placeholder="e.g. Auditor" required />
                            </div>
                            <div>
                                <label className="label">Description</label>
                                <input type="text" className="input" value={form.description}
                                    onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                                    placeholder="Brief description of role" />
                            </div>
                        </div>
                        <div className="flex justify-end gap-2">
                            <button type="button" onClick={() => { setShowForm(false); setEditRole(null); }}
                                className="btn-secondary text-sm">Cancel</button>
                            <button type="submit" className="btn-primary text-sm">
                                {editRole ? 'Save Changes' : 'Add Role'}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            <div className="overflow-hidden rounded-lg border border-gray-200">
                <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="table-header">Role Name</th>
                            <th className="table-header">Description</th>
                            <th className="table-header">Type</th>
                            <th className="table-header">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {roles.map(r => (
                            <tr key={r.id} className="hover:bg-gray-50">
                                <td className="table-cell font-medium text-gray-900">{r.name}</td>
                                <td className="table-cell text-gray-500 text-sm">{r.description || '—'}</td>
                                <td className="table-cell">
                                    {r.is_system_role
                                        ? <span className="badge-blue">System</span>
                                        : <span className="badge-green">Custom</span>
                                    }
                                </td>
                                <td className="table-cell">
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => setPermRole(r)}
                                            className="p-1.5 rounded-lg bg-primary-50 text-primary-700
                                                hover:bg-primary-100 transition-colors"
                                            title="Manage permissions"
                                        >
                                            <ShieldCheckIcon className="h-4 w-4" />
                                        </button>
                                        {!r.is_system_role && (
                                            <button
                                                onClick={() => openEdit(r)}
                                                className="p-1.5 rounded-lg bg-gray-50 text-gray-500
                                                    hover:bg-gray-100 transition-colors"
                                                title="Edit role"
                                            >
                                                <PencilIcon className="h-4 w-4" />
                                            </button>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                </div>
            </div>

            <PermissionsModal
                isOpen={!!permRole}
                role={permRole}
                onClose={() => setPermRole(null)}
                onSuccess={() => setSuccess(`Permissions updated for "${permRole?.name}"`)}
            />
        </div>
    );
};

// ============================================================
// CATEGORIES TAB
// ============================================================
const CategoriesTab = () => {
    const [categories,   setCategories]   = useState([]);
    const [loading,      setLoading]      = useState(true);
    const [error,        setError]        = useState(null);
    const [success,      setSuccess]      = useState(null);
    const [showForm,     setShowForm]     = useState(false);
    const [editCategory, setEditCategory] = useState(null);
    const [moduleFilter, setModuleFilter] = useState('FINANCE');
    const [form, setForm] = useState({
        module: 'FINANCE', parent_id: '', name: '', abbreviation: '', description: '',
    });

    const load = useCallback(async () => {
        try {
            setLoading(true);
            const res = await categoriesAPI.getAll({ module: moduleFilter, flat: true });
            setCategories(res.data.data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [moduleFilter]);

    useEffect(() => { load(); }, [load]);

    const openAdd = () => {
        setEditCategory(null);
        setForm({ module: moduleFilter, parent_id: '', name: '', abbreviation: '', description: '' });
        setShowForm(true);
    };

    const openEdit = (cat) => {
        setEditCategory(cat);
        setForm({
            module: cat.module,
            parent_id: cat.parent_id || '',
            name: cat.name,
            abbreviation: cat.abbreviation,
            description: cat.description || '',
        });
        setShowForm(true);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError(null);
        setSuccess(null);
        try {
            if (editCategory) {
                await categoriesAPI.update(editCategory.id, {
                    name: form.name,
                    abbreviation: form.abbreviation,
                    description: form.description,
                });
                setSuccess(`Category "${form.name}" updated successfully`);
            } else {
                await categoriesAPI.create({
                    ...form,
                    parent_id: form.parent_id ? parseInt(form.parent_id) : undefined,
                });
                setSuccess(`Category "${form.name}" added successfully`);
            }
            setForm({ module: moduleFilter, parent_id: '', name: '', abbreviation: '', description: '' });
            setShowForm(false);
            setEditCategory(null);
            load();
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    const modules = ['FINANCE', 'DOCUMENT', 'EVENT', 'INVESTMENT', 'GENERAL'];

    if (loading) return <LoadingSpinner size="md" text="Loading categories..." />;

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex gap-2 flex-wrap">
                    {modules.map(m => (
                        <button key={m} onClick={() => setModuleFilter(m)}
                            className={`px-3 py-1 rounded-lg text-xs font-medium
                                transition-colors ${moduleFilter === m
                                    ? 'bg-primary-700 text-white'
                                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                }`}>
                            {m}
                        </button>
                    ))}
                </div>
                <button onClick={openAdd} className="btn-primary flex items-center gap-2 text-sm">
                    <PlusIcon className="h-4 w-4" />
                    Add Category
                </button>
            </div>

            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {success && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700">
                    {success}
                </div>
            )}

            {showForm && (
                <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                    <h4 className="text-sm font-semibold text-gray-700 mb-3">
                        {editCategory ? `Edit: ${editCategory.name}` : `Add New Category — ${moduleFilter}`}
                    </h4>
                    <form onSubmit={handleSubmit}>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                            {!editCategory && (
                                <div className="col-span-2">
                                    <label className="label">Parent Category</label>
                                    <select className="input" value={form.parent_id}
                                        onChange={e => setForm(p => ({ ...p, parent_id: e.target.value }))}>
                                        <option value="">None (top-level category)</option>
                                        {categories.map(c => (
                                            <option key={c.id} value={c.id}>
                                                {'—'.repeat(c.depth || 0)} {c.name}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}
                            <div>
                                <label className="label">Category Name *</label>
                                <input type="text" className="input" value={form.name}
                                    onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                                    required />
                            </div>
                            <div>
                                <label className="label">Abbreviation *</label>
                                <input type="text" className="input" value={form.abbreviation}
                                    onChange={e => setForm(p => ({ ...p, abbreviation: e.target.value.toUpperCase() }))}
                                    placeholder="e.g. ADMIN" maxLength={20} required />
                            </div>
                            <div className="col-span-2">
                                <label className="label">Description</label>
                                <input type="text" className="input" value={form.description}
                                    onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
                            </div>
                        </div>
                        <div className="flex justify-end gap-2">
                            <button type="button"
                                onClick={() => { setShowForm(false); setEditCategory(null); }}
                                className="btn-secondary text-sm">Cancel</button>
                            <button type="submit" className="btn-primary text-sm">
                                {editCategory ? 'Save Changes' : 'Add Category'}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            <div className="overflow-hidden rounded-lg border border-gray-200">
                <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="table-header">Category</th>
                            <th className="table-header">Full Path</th>
                            <th className="table-header">Abbreviation</th>
                            <th className="table-header">Depth</th>
                            <th className="table-header">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {categories.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-6 py-8 text-center text-sm text-gray-400">
                                    No categories found for {moduleFilter}
                                </td>
                            </tr>
                        ) : categories.map(c => (
                            <tr key={c.id} className="hover:bg-gray-50">
                                <td className="table-cell">
                                    <span style={{ paddingLeft: `${(c.depth || 0) * 16}px` }}>
                                        {c.depth > 0 && (
                                            <span className="text-gray-300 mr-1">└</span>
                                        )}
                                        <span className="font-medium text-gray-900">{c.name}</span>
                                    </span>
                                </td>
                                <td className="table-cell text-xs text-gray-500">
                                    {c.full_path || c.name}
                                </td>
                                <td className="table-cell">
                                    <span className="font-mono text-xs text-primary-700">
                                        {c.abbreviation}
                                    </span>
                                </td>
                                <td className="table-cell text-sm text-gray-500">
                                    {c.depth || 0}
                                </td>
                                <td className="table-cell">
                                    <button
                                        onClick={() => openEdit(c)}
                                        className="p-1.5 rounded-lg bg-gray-50 text-gray-500
                                            hover:bg-gray-100 transition-colors"
                                        title="Edit category"
                                    >
                                        <PencilIcon className="h-4 w-4" />
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// COMPANY TAB
// Lets a System Admin rebrand the whole installation — name,
// address, logo, and the two brand colors used across the sidebar,
// buttons, badges, and every generated document's letterhead.
// Changes take effect immediately for every user, no redeploy.
// ============================================================
const CompanyTab = () => {
    const { branding, refresh } = useBranding();
    const [form, setForm] = useState({
        company_name: '', company_address: '',
        primary_color: '#1e3a5f', accent_color: '#c9a227',
        description: '', mission: '', vision: '', core_values: '', motto: '',
    });
    const [logoFile, setLogoFile] = useState(null);
    const [logoPreview, setLogoPreview] = useState(null);
    const [loading, setLoading] = useState(false);
    const [uploadingLogo, setUploadingLogo] = useState(false);
    const [error,   setError]   = useState(null);
    const [success, setSuccess] = useState(null);

    useEffect(() => {
        setForm({
            company_name:    branding.company_name || '',
            company_address: branding.company_address || '',
            primary_color:   branding.primary_color || '#1e3a5f',
            accent_color:    branding.accent_color || '#c9a227',
            description:     branding.description || '',
            mission:         branding.mission || '',
            vision:          branding.vision || '',
            core_values:     branding.core_values || '',
            motto:           branding.motto || '',
        });
    }, [branding]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError(null);
        setSuccess(null);
        setLoading(true);
        try {
            await settingsAPI.updateCompany(form);
            await refresh();
            setSuccess('Company settings updated');
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const handleLogoChange = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setLogoFile(file);
        setLogoPreview(URL.createObjectURL(file));
    };

    const handleLogoUpload = async () => {
        if (!logoFile) return;
        setError(null);
        setSuccess(null);
        setUploadingLogo(true);
        try {
            const formData = new FormData();
            formData.append('logo', logoFile);
            await settingsAPI.uploadLogo(formData);
            await refresh();
            setSuccess('Logo updated');
            setLogoFile(null);
            setLogoPreview(null);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setUploadingLogo(false);
        }
    };

    return (
        <div className="space-y-6 max-w-2xl">
            <p className="text-sm text-gray-500">
                These settings control the company identity shown across the
                sidebar, topbar, and every generated document (meeting minutes,
                statements, receipts, and so on). Changes apply immediately —
                no redeploy needed.
            </p>

            {error && <ErrorMessage message={error} onDismiss={() => setError(null)} />}
            {success && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700">
                    {success}
                </div>
            )}

            {/* Logo */}
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <h4 className="text-sm font-semibold text-gray-700 mb-3">Company Logo</h4>
                <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-lg border border-gray-200 bg-white
                        flex items-center justify-center overflow-hidden flex-shrink-0">
                        <img
                            src={logoPreview || branding.logo_url || '/logo.png'}
                            alt="Company logo"
                            className="w-full h-full object-contain"
                            onError={e => { e.target.style.display = 'none'; }}
                        />
                    </div>
                    <div className="flex-1">
                        <input type="file" accept="image/png,image/jpeg,image/gif"
                            onChange={handleLogoChange}
                            className="text-sm text-gray-500" />
                        {logoFile && (
                            <button
                                onClick={handleLogoUpload}
                                disabled={uploadingLogo}
                                className="btn-primary text-sm mt-2 flex items-center gap-2"
                            >
                                <ArrowUpTrayIcon className="h-4 w-4" />
                                {uploadingLogo ? 'Uploading...' : 'Upload Logo'}
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Name, address, colors */}
            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <label className="label">Company Name *</label>
                    <input type="text" className="input" value={form.company_name}
                        onChange={e => setForm(p => ({ ...p, company_name: e.target.value }))}
                        required />
                </div>
                <div>
                    <label className="label">Company Address</label>
                    <textarea className="input" rows={2} value={form.company_address}
                        onChange={e => setForm(p => ({ ...p, company_address: e.target.value }))}
                        placeholder="Full registered address — shown on every document's letterhead" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <label className="label">Primary Color</label>
                        <div className="flex items-center gap-2">
                            <input type="color" value={form.primary_color}
                                onChange={e => setForm(p => ({ ...p, primary_color: e.target.value }))}
                                className="h-9 w-12 rounded border border-gray-200 cursor-pointer" />
                            <input type="text" className="input" value={form.primary_color}
                                onChange={e => setForm(p => ({ ...p, primary_color: e.target.value }))} />
                        </div>
                        <p className="text-xs text-gray-400 mt-1">Sidebar, headings, document letterhead</p>
                    </div>
                    <div>
                        <label className="label">Accent Color</label>
                        <div className="flex items-center gap-2">
                            <input type="color" value={form.accent_color}
                                onChange={e => setForm(p => ({ ...p, accent_color: e.target.value }))}
                                className="h-9 w-12 rounded border border-gray-200 cursor-pointer" />
                            <input type="text" className="input" value={form.accent_color}
                                onChange={e => setForm(p => ({ ...p, accent_color: e.target.value }))} />
                        </div>
                        <p className="text-xs text-gray-400 mt-1">Document trail highlights</p>
                    </div>
                </div>

                {/* About content */}
                <div className="border-t border-gray-100 pt-4 mt-2">
                    <h4 className="text-sm font-semibold text-gray-700 mb-1">About</h4>
                    <p className="text-xs text-gray-400 mb-3">
                        Optional — a short profile of the company, shown wherever
                        an "About" section is needed.
                    </p>
                    <div className="space-y-4">
                        <div>
                            <label className="label">Motto</label>
                            <input type="text" className="input" value={form.motto}
                                onChange={e => setForm(p => ({ ...p, motto: e.target.value }))}
                                placeholder="A short tagline, e.g. &quot;Growing together, prospering together&quot;"
                                maxLength={300} />
                        </div>
                        <div>
                            <label className="label">Description</label>
                            <textarea className="input" rows={3} value={form.description}
                                onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                                placeholder="A short description of the company..." />
                        </div>
                        <div>
                            <label className="label">Mission</label>
                            <textarea className="input" rows={2} value={form.mission}
                                onChange={e => setForm(p => ({ ...p, mission: e.target.value }))}
                                placeholder="What the company set out to do..." />
                        </div>
                        <div>
                            <label className="label">Vision</label>
                            <textarea className="input" rows={2} value={form.vision}
                                onChange={e => setForm(p => ({ ...p, vision: e.target.value }))}
                                placeholder="Where the company aims to be..." />
                        </div>
                        <div>
                            <label className="label">Core Values</label>
                            <textarea className="input" rows={2} value={form.core_values}
                                onChange={e => setForm(p => ({ ...p, core_values: e.target.value }))}
                                placeholder="e.g. Integrity, Transparency, Accountability..." />
                        </div>
                    </div>
                </div>

                <div className="flex justify-end">
                    <button type="submit" disabled={loading} className="btn-primary text-sm">
                        {loading ? 'Saving...' : 'Save Changes'}
                    </button>
                </div>
            </form>
        </div>
    );
};

// ============================================================
// MAIN SETTINGS PAGE
// ============================================================
const SettingsPage = () => {
    const { isAdmin } = useAuth();
    const [activeTab, setActiveTab] = useState('currencies');

    if (!isAdmin()) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center">
                    <h2 className="text-xl font-semibold text-gray-900 mb-2">
                        Access Denied
                    </h2>
                    <p className="text-gray-500">
                        Settings are only accessible to system administrators.
                    </p>
                </div>
            </div>
        );
    }

    const tabs = [
        { key: 'company',    label: 'Company',    icon: BuildingOffice2Icon },
        { key: 'currencies', label: 'Currencies', icon: BanknotesIcon },
        { key: 'roles',      label: 'Roles',      icon: UserGroupIcon },
        { key: 'categories', label: 'Categories', icon: TagIcon },
    ];

    return (
        <div className="max-w-5xl">
            <PageHeader
                title="Settings"
                subtitle="System configuration — currencies, roles and categories"
            />

            <div className="flex gap-2 mb-6">
                {tabs.map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => setActiveTab(tab.key)}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg
                            text-sm font-medium transition-colors ${
                            activeTab === tab.key
                                ? 'bg-primary-700 text-white'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                    >
                        <tab.icon className="h-4 w-4" />
                        {tab.label}
                    </button>
                ))}
            </div>

            <div className="card">
                {activeTab === 'company'    && <CompanyTab />}
                {activeTab === 'currencies' && <CurrenciesTab />}
                {activeTab === 'roles'      && <RolesTab />}
                {activeTab === 'categories' && <CategoriesTab />}
            </div>
        </div>
    );
};

export default SettingsPage;