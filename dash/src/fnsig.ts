// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// What each formula function takes — the list the formula dialog searches.
//
// The arguments are written the way Excel's own tooltip writes them, square
// brackets for an optional one and "…" for "as many as you like", because the
// reader who looks this up is usually translating a formula they already know.
// They are formula SYNTAX, not prose, so they are not translated: a German
// Excel user reads `SUMIF(range, criteria, [sum_range])` in the same docs.
//
// EVERY name in formula.ts's FUNCTIONS has an entry, and no entry names a
// function that does not exist — scripts/test-dash-formula-dialog.ts holds the
// two lists against each other, so adding a function without its signature (or
// deleting one and leaving its signature behind) fails the build.

export const FN_SIGNATURE: Record<string, string> = {
  ABS: 'ABS(number)',
  AND: 'AND(logical1, [logical2], …)',
  AVERAGE: 'AVERAGE(number1, [number2], …)',
  AVERAGEIF: 'AVERAGEIF(range, criteria, [average_range])',
  AVERAGEIFS: 'AVERAGEIFS(average_range, criteria_range1, criteria1, …)',
  AVG: 'AVG(number1, [number2], …)',
  CEILING: 'CEILING(number, [significance])',
  CHOOSE: 'CHOOSE(index, value1, [value2], …)',
  CONCAT: 'CONCAT(text1, [text2], …)',
  CONCATENATE: 'CONCATENATE(text1, [text2], …)',
  CORREL: 'CORREL(array1, array2)',
  COUNT: 'COUNT(value1, [value2], …)',
  COUNTA: 'COUNTA(value1, [value2], …)',
  COUNTBLANK: 'COUNTBLANK(range)',
  COUNTIF: 'COUNTIF(range, criteria)',
  COUNTIFS: 'COUNTIFS(criteria_range1, criteria1, …)',
  COUNTUNIQUE: 'COUNTUNIQUE(value1, [value2], …)',
  DATE: 'DATE(year, month, day)',
  DATEVALUE: 'DATEVALUE(date_text)',
  DAY: 'DAY(date)',
  DAYS: 'DAYS(end_date, start_date)',
  EDATE: 'EDATE(start_date, months)',
  EOMONTH: 'EOMONTH(start_date, months)',
  EXP: 'EXP(number)',
  FALSE: 'FALSE()',
  FIND: 'FIND(find_text, within_text, [start_num])',
  FLOOR: 'FLOOR(number, [significance])',
  FV: 'FV(rate, nper, pmt, [pv], [type])',
  HLOOKUP: 'HLOOKUP(lookup_value, table, row_index, [range_lookup])',
  IF: 'IF(logical_test, value_if_true, [value_if_false])',
  IFERROR: 'IFERROR(value, value_if_error)',
  IFNA: 'IFNA(value, value_if_na)',
  IFS: 'IFS(test1, value1, [test2, value2], …)',
  INDEX: 'INDEX(array, row_num, [column_num])',
  INT: 'INT(number)',
  IRR: 'IRR(values, [guess])',
  ISBLANK: 'ISBLANK(value)',
  ISERROR: 'ISERROR(value)',
  ISNUMBER: 'ISNUMBER(value)',
  ISTEXT: 'ISTEXT(value)',
  LARGE: 'LARGE(array, k)',
  LEFT: 'LEFT(text, [num_chars])',
  LEN: 'LEN(text)',
  LN: 'LN(number)',
  LOG10: 'LOG10(number)',
  LOOKUP: 'LOOKUP(lookup_value, lookup_vector, [result_vector])',
  LOWER: 'LOWER(text)',
  MATCH: 'MATCH(lookup_value, lookup_array, [match_type])',
  MAX: 'MAX(number1, [number2], …)',
  MAXIFS: 'MAXIFS(max_range, criteria_range1, criteria1, …)',
  MEDIAN: 'MEDIAN(number1, [number2], …)',
  MID: 'MID(text, start_num, num_chars)',
  MIN: 'MIN(number1, [number2], …)',
  MINIFS: 'MINIFS(min_range, criteria_range1, criteria1, …)',
  MOD: 'MOD(number, divisor)',
  MODE: 'MODE(number1, [number2], …)',
  MONTH: 'MONTH(date)',
  NOT: 'NOT(logical)',
  NOW: 'NOW()',
  NPV: 'NPV(rate, value1, [value2], …)',
  OR: 'OR(logical1, [logical2], …)',
  PERCENTILE: 'PERCENTILE(array, k)',
  PMT: 'PMT(rate, nper, pv, [fv], [type])',
  POWER: 'POWER(number, power)',
  PRODUCT: 'PRODUCT(number1, [number2], …)',
  PROPER: 'PROPER(text)',
  PV: 'PV(rate, nper, pmt, [fv], [type])',
  QUARTILE: 'QUARTILE(array, quart)',
  RANK: 'RANK(number, ref, [order])',
  REPLACE: 'REPLACE(old_text, start_num, num_chars, new_text)',
  REPT: 'REPT(text, number_times)',
  RIGHT: 'RIGHT(text, [num_chars])',
  ROUND: 'ROUND(number, num_digits)',
  ROUNDDOWN: 'ROUNDDOWN(number, num_digits)',
  ROUNDUP: 'ROUNDUP(number, num_digits)',
  SEARCH: 'SEARCH(find_text, within_text, [start_num])',
  SIGN: 'SIGN(number)',
  SMALL: 'SMALL(array, k)',
  SQRT: 'SQRT(number)',
  STDEV: 'STDEV(number1, [number2], …)',
  STDEVP: 'STDEVP(number1, [number2], …)',
  SUBSTITUTE: 'SUBSTITUTE(text, old_text, new_text)',
  SUBTOTAL: 'SUBTOTAL(function_num, ref1, [ref2], …)',
  SUM: 'SUM(number1, [number2], …)',
  SUMIF: 'SUMIF(range, criteria, [sum_range])',
  SUMIFS: 'SUMIFS(sum_range, criteria_range1, criteria1, …)',
  SUMPRODUCT: 'SUMPRODUCT(array1, [array2], …)',
  SWITCH: 'SWITCH(expression, value1, result1, …, [default])',
  TEXT: 'TEXT(value, format_text)',
  TEXTJOIN: 'TEXTJOIN(delimiter, ignore_empty, text1, …)',
  TODAY: 'TODAY()',
  TRANSPOSE: 'TRANSPOSE(array)',
  TRIM: 'TRIM(text)',
  TRUE: 'TRUE()',
  UPPER: 'UPPER(text)',
  VALUE: 'VALUE(text)',
  VAR: 'VAR(number1, [number2], …)',
  VARP: 'VARP(number1, [number2], …)',
  VLOOKUP: 'VLOOKUP(lookup_value, table, col_index, [range_lookup])',
  WEEKDAY: 'WEEKDAY(date, [return_type])',
  XLOOKUP: 'XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found])',
  XOR: 'XOR(logical1, [logical2], …)',
  YEAR: 'YEAR(date)',
}

/**
 * The functions that match what the reader typed, best first: a name that
 * STARTS with the query before one that merely contains it, then A–Z. Empty
 * query, every function.
 */
export function matchFunctions(names: readonly string[], query: string): string[] {
  const q = query.trim().toUpperCase()
  if (!q) return [...names].sort()
  const starts = names.filter((n) => n.startsWith(q)).sort()
  const within = names.filter((n) => !n.startsWith(q) && n.includes(q)).sort()
  return [...starts, ...within]
}

/**
 * The identifier the caret is in the middle (or at the end) of — what an
 * autocomplete should be completing. `null` when the caret is not touching a
 * word, or the word is inside a string or a [bracketed column].
 */
export function wordAtCaret(src: string, caret: number): { word: string; from: number; to: number } | null {
  // inside a quoted string, or an open [column name]? Count from the start.
  let inStr = false, inBr = false
  for (let i = 0; i < caret; i++) {
    const c = src[i]
    if (inStr) { if (c === '"') inStr = false; continue }
    if (inBr) { if (c === ']') inBr = false; continue }
    if (c === '"') inStr = true
    else if (c === '[') inBr = true
  }
  if (inStr || inBr) return null
  let from = caret, to = caret
  while (from > 0 && /[A-Za-z0-9_.]/.test(src[from - 1])) from--
  while (to < src.length && /[A-Za-z0-9_.]/.test(src[to])) to++
  if (from === to || !/[A-Za-z_]/.test(src[from])) return null
  return { word: src.slice(from, to), from, to }
}
