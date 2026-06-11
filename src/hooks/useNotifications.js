// src/hooks/useNotifications.js
// Polls /api/notifications every 60s when authed.
// Returns: { notifications, unreadCount, markAllRead, alertSettings, saveAlertSettings }

import { useState, useEffect, useCallback, useRef } from 'react'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const POLL_MS     = 60_000

export default function useNotifications ({ authToken, isAuthed }) {
  const [notifications,  setNotifications]  = useState([])
  const [alertSettings,  setAlertSettings]  = useState(null)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const intervalRef = useRef(null)

  const fetchNotifications = useCallback(async () => {
    if (!authToken) return
    try {
      const res = await fetch(`${BACKEND_URL}/api/notifications`, {
        headers: { Authorization: `Bearer ${authToken}` },
      })
      if (!res.ok) return
      const data = await res.json()
      setNotifications(data.notifications || [])
    } catch { /* silent */ }
  }, [authToken])

  const fetchAlertSettings = useCallback(async () => {
    if (!authToken) return
    try {
      const res = await fetch(`${BACKEND_URL}/api/alerts/settings`, {
        headers: { Authorization: `Bearer ${authToken}` },
      })
      if (!res.ok) return
      const data = await res.json()
      setAlertSettings(data)
    } catch { /* silent */ }
  }, [authToken])

  // Start polling when authed
  useEffect(() => {
    if (!isAuthed || !authToken) {
      setNotifications([])
      setAlertSettings(null)
      if (intervalRef.current) clearInterval(intervalRef.current)
      return
    }
    fetchNotifications()
    fetchAlertSettings()
    intervalRef.current = setInterval(fetchNotifications, POLL_MS)
    return () => clearInterval(intervalRef.current)
  }, [isAuthed, authToken, fetchNotifications, fetchAlertSettings])

  const unreadCount = notifications.filter(n => !n.read).length

  const markAllRead = useCallback(async () => {
    if (!authToken || unreadCount === 0) return
    try {
      await fetch(`${BACKEND_URL}/api/notifications/read`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      })
      setNotifications(prev => prev.map(n => ({ ...n, read: true })))
    } catch { /* silent */ }
  }, [authToken, unreadCount])

  const saveAlertSettings = useCallback(async (updates) => {
    if (!authToken) return
    setSettingsSaving(true)
    try {
      const res = await fetch(`${BACKEND_URL}/api/alerts/settings`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body:    JSON.stringify(updates),
      })
      if (res.ok) {
        setAlertSettings(prev => ({ ...prev, ...updates }))
      }
    } catch { /* silent */ }
    finally { setSettingsSaving(false) }
  }, [authToken])

  return {
    notifications,
    unreadCount,
    markAllRead,
    alertSettings,
    saveAlertSettings,
    settingsSaving,
    refetch: fetchNotifications,
  }
}