import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { formatAxisValue } from '../../office/sheets/src/renderer/WorkbookVisuals'

describe('chart value-axis labels', () => {
  test('shows the explicit percentage precision and preserves zero and negative ticks', () => {
    assert.equal(formatAxisValue(0.2, '0.0%'), '20.0%')
    assert.equal(formatAxisValue(0, '0.00%'), '0.00%')
    assert.equal(formatAxisValue(-0.125, '0.0%'), '-12.5%')
    assert.equal(formatAxisValue(0.125, '0%'), '13%')
  })

  test('formats the primary amount axis independently and retains general fallback', () => {
    assert.equal(formatAxisValue(12500, '#,##0'), '12,500')
    assert.equal(formatAxisValue(12500.5, '$#,##0.00'), '$12,500.50')
    assert.equal(formatAxisValue(12.3456, 'General'), '12.3456')
  })
})
