'use strict'

const MIN_CANVAS_ZOOM = 0.25
const MAX_CANVAS_ZOOM = 2.5
const CANVAS_ZOOM_STEP = 0.25

function clampCanvasZoom(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.round(Math.max(MIN_CANVAS_ZOOM, Math.min(MAX_CANVAS_ZOOM, n)) * 100) / 100
}

function stepCanvasZoom(value, direction) {
  const sign = Math.sign(Number(direction) || 0)
  if (!sign) return clampCanvasZoom(value)
  const current = clampCanvasZoom(value)
  const nextStep = Math.round(current / CANVAS_ZOOM_STEP) + sign
  return clampCanvasZoom(nextStep * CANVAS_ZOOM_STEP)
}

function fitCanvasZoom(viewportWidth, canvasWidth = 760, gutter = 24) {
  const viewport = Number(viewportWidth)
  const base = Number(canvasWidth)
  const margin = Number(gutter)
  if (!Number.isFinite(viewport) || viewport <= 0
    || !Number.isFinite(base) || base <= 0
    || !Number.isFinite(margin) || margin < 0) return 1
  return clampCanvasZoom((viewport - margin) / base)
}

module.exports = {
  MIN_CANVAS_ZOOM,
  MAX_CANVAS_ZOOM,
  CANVAS_ZOOM_STEP,
  clampCanvasZoom,
  stepCanvasZoom,
  fitCanvasZoom,
}
