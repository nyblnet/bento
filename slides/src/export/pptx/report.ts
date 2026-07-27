// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors

export interface PptxWarning {
  slide: number
  element?: string
  code: string
}

export interface PptxExportReport {
  slides: number
  editable: number
  vectorFallbacks: number
  warnings: PptxWarning[]
}

export class ReportBuilder {
  editable = 0
  vectorFallbacks = 0
  warnings: PptxWarning[] = []

  warn(slide: number, code: string, element?: string) {
    // Runtime-only effects are one compatibility fact per slide, not one alert
    // per animated decorative dot. Keep the report actionable and compact.
    if (code === 'presentation-effects-static') element = undefined
    if (!this.warnings.some((w) => w.slide === slide && w.element === element && w.code === code)) {
      this.warnings.push({ slide, element, code })
    }
  }

  finish(slides: number): PptxExportReport {
    return { slides, editable: this.editable, vectorFallbacks: this.vectorFallbacks, warnings: this.warnings }
  }
}
