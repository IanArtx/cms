// ============================================================
// AXIOS CONFIGURATION
// Central HTTP client for all API calls.
// Automatically attaches the auth token to every request
// and handles token expiry globally.
// ============================================================

import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const api = axios.create({
    baseURL: API_BASE_URL,
    headers: {
        'Content-Type': 'application/json',
    },
});

// ============================================================
// REQUEST INTERCEPTOR
// Attaches the JWT token to every outgoing request.
// ============================================================
api.interceptors.request.use(
    (config) => {
        const token = localStorage.getItem('accessToken');
        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
    },
    (error) => Promise.reject(error)
);

// ============================================================
// RESPONSE INTERCEPTOR
// Handles token expiry globally.
// If a 401 is received, clears tokens and redirects to login.
// ============================================================
api.interceptors.response.use(
    (response) => response,
    async (error) => {
        const originalRequest = error.config;

        // Only treat a 401 as "your session expired" if there was a
        // session to expire. A visitor on a public page (Login,
        // Register, Forgot/Reset Password) has no accessToken yet —
        // if one of those pages ever calls a protected endpoint by
        // mistake, the resulting 401 should just fail quietly, not
        // hard-redirect the whole app back to /login mid-render.
        const hadToken = !!localStorage.getItem('accessToken');

        // If 401 and we haven't already retried
        if (error.response?.status === 401 && !originalRequest._retry && hadToken) {
            originalRequest._retry = true;

            const refreshToken = localStorage.getItem('refreshToken');
            if (refreshToken) {
                try {
                    const response = await axios.post(
                        `${API_BASE_URL}/auth/refresh`,
                        { refreshToken }
                    );
                    const { accessToken } = response.data.data;
                    localStorage.setItem('accessToken', accessToken);
                    originalRequest.headers.Authorization = `Bearer ${accessToken}`;
                    return api(originalRequest);
                } catch {
                    // Refresh failed — clear everything and redirect to login
                    localStorage.removeItem('accessToken');
                    localStorage.removeItem('refreshToken');
                    localStorage.removeItem('user');
                    window.location.href = '/login';
                }
            } else {
                localStorage.removeItem('accessToken');
                localStorage.removeItem('refreshToken');
                localStorage.removeItem('user');
                window.location.href = '/login';
            }
        }

        return Promise.reject(error);
    }
);

export default api;