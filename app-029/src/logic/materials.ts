/**
 * 材料清单（BOM）与报价（规格书第 4.6 / 5 节）：
 * - 面板：异形字按「外接矩形」拆成料件（每个连通域一件），再做分层拼版；
 * - 金额一律整数「分」，Σ 明细金额 = 合计；
 * - 最细笔画低于工艺下限时「警告并可拦截」：未确认风险前不出报价单。
 */

import materialsData from '../data/materials.json'
import type { LedResult, Material, Project } from './types'
import type { LayoutResult, PlacedChar } from './layout'
import { nestPieces, type CutItem, type NestingResult, type Piece } from './nesting'
import { computeLed, type PsuPreset } from './led'

export interface SheetSpec {
  id: string
  spec: string
  wMm: number
  hMm: number
  thicknessMm: number
  priceCents: number
  kerfMm: number
}

export interface LedModuleSpec {
  id: string
  spec: string
  spacingMm: number
  powerW: number
  lumen: number
  priceCents: number
  voltageV: number
}

export interface RuleSpec {
  type: 'perPieceAreaM2' | 'perChar' | 'perMeterPerimeter' | 'perPsu' | 'perModule' | 'perStrokeBlock' | 'perOutlinePerimeter'
  value: number
  minQty: number
}

export interface ConsumableSpec {
  id: string
  spec: string
  unit: string
  unitPriceCents: number
  rule: RuleSpec
}

export interface LaborSpec {
  id: string
  spec: string
  unit: string
  unitPriceCents: number
  rule: RuleSpec
}

export interface PanelMaterialSpec {
  id: string
  name: string
  desc: string
  useLed: boolean
  areaPriceCentsPerM2: number
  perimeterPriceCentsPerM: number
  charLaborCents: number
}

export interface Preset {
  version: string
  process: {
    strokeLimitMm: number
    defaultTrackRatio: number
    defaultMarginRatio: number
    defaultLineGapRatio: number
    panelFrameMm: number
    minTrackMm: number
    maxTrackMm: number
    warnTrackRatioLow: number
    warnTrackRatioHigh: number
  }
  acrylicSheets: SheetSpec[]
  ledModules: LedModuleSpec[]
  psu: PsuPreset
  consumables: ConsumableSpec[]
  labor: LaborSpec[]
  panelMaterials: PanelMaterialSpec[]
}

export const defaultPreset = materialsData as unknown as Preset

export interface BomResult {
  materials: Material[]
  totalCents: number
  led: LedResult
  nesting: NestingResult
  sheet: SheetSpec
  module: LedModuleSpec
  cutList: CutItem[]
  pieceAreaM2: number
  outlinePerimeterM: number
  /** 工艺拦截：未确认风险时不出报价 */
  blocked: boolean
  blockReasons: string[]
  panelMaterial: PanelMaterialSpec
}

export interface BomOptions {
  /** 已确认「最细笔画低于工艺下限」的风险 */
  acknowledgeThinStroke?: boolean
}

/**
 * 用量规则取值（规格书第 4.6 节）：
 * - 每一项必须按自己的计量口径取值，不能一律跟着字数走；
 * - 毛用量 = 计量基数 × 系数 value；
 * - 起订量 minQty：毛用量不足时按 minQty 计（系数 value 为 0 时同样适用）；
 * - 用量为 0 且无起订量（minQty = 0）→ 不计该项（不进明细）；
 * - 整件采购单位（支/套/个/台…）数量必须向上取整，绝不出现小数件数；
 *   米、㎡、字 等按用量折算的单位保留小数，金额按未取整的真实用量折算，
 *   因此「各分项金额之和 = 合计」恒成立。
 */
export interface RuleContext {
  areaM2: number
  chars: number
  perimeterM: number
  psu: number
  modules: number
  blocks: number
  outlinePerimeterM: number
}

/** 整件采购、只能整件买卖的单位：数量一律向上取整 */
const PIECE_UNITS = new Set(['支', '套', '个', '台', '只', '张', '根', '瓶', '盒', '包'])

export function isPieceUnit(unit: string): boolean {
  return PIECE_UNITS.has(unit)
}

/** 按规则类型取毛用量（未取整） */
function rawRuleQty(rule: RuleSpec, ctx: RuleContext): number {
  const base =
    rule.type === 'perPieceAreaM2'
      ? ctx.areaM2
      : rule.type === 'perChar'
        ? ctx.chars
        : rule.type === 'perMeterPerimeter'
          ? ctx.perimeterM
          : rule.type === 'perPsu'
            ? ctx.psu
            : rule.type === 'perModule'
              ? ctx.modules
              : rule.type === 'perStrokeBlock'
                ? ctx.blocks
                : ctx.outlinePerimeterM
  return base * rule.value
}

/**
 * 按规则计算明细数量：
 * 1) 毛用量 = 基数 × 系数；系数为 0 → 毛用量 0；
 * 2) 与起订量取大（Math.max）；
 * 3) 整件单位向上取整，其余单位保留小数（按用量折算）；
 * 4) 结果为 0 → 该项不计（返回 0，由调用方跳过）。
 */
export function ruleQuantity(rule: RuleSpec, unit: string, ctx: RuleContext): number {
  const withMin = Math.max(rule.minQty || 0, rawRuleQty(rule, ctx))
  if (withMin <= 0) return 0
  return isPieceUnit(unit) ? Math.ceil(withMin - 1e-9) : withMin
}

/**
 * 金额折算：整件单位按取整后件数计价；折算单位按未取整毛用量（套用起订量后）计价，
 * 再四舍五入到整数「分」。返回 { qty, amountCents }，qty 为 0 表示该项不计。
 */
function priceRuleItem(rule: RuleSpec, unit: string, unitPriceCents: number, ctx: RuleContext): { qty: number; amountCents: number } {
  const withMin = Math.max(rule.minQty || 0, rawRuleQty(rule, ctx))
  if (withMin <= 0) return { qty: 0, amountCents: 0 }
  if (isPieceUnit(unit)) {
    const qty = Math.ceil(withMin - 1e-9)
    return { qty, amountCents: qty * unitPriceCents }
  }
  return { qty: withMin, amountCents: Math.round(withMin * unitPriceCents) }
}

/** 明细数量显示：整件单位为整数；折算单位保留至多 3 位小数 */
export function formatQty(qty: number, piece: boolean): string {
  return piece ? String(qty) : String(Math.round(qty * 1000) / 1000)
}

/** 拆料件：每个连通域（笔画块）一件，按外接矩形计 */
export function acrylicPieces(chars: PlacedChar[]): Piece[] {
  const out: Piece[] = []
  let seq = 0
  for (const c of chars) {
    if (c.missing || c.blank || c.geom.blockBBoxes.length === 0) continue
    const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
    c.geom.blockBBoxes.forEach((b, bi) => {
      const wMm = Math.max(1, Math.ceil((b.x1 - b.x0) * k))
      const hMm = Math.max(1, Math.ceil((b.y1 - b.y0) * k))
      out.push({ id: `p${seq++}`, label: `${c.char}-${bi + 1}`, wMm, hMm })
    })
  }
  return out
}

export function buildBom(project: Project, layout: LayoutResult, preset: Preset, opts: BomOptions = {}): BomResult {
  const sheet = preset.acrylicSheets.find((s) => s.id === project.sheetId) ?? preset.acrylicSheets[0]
  const module = preset.ledModules.find((m) => m.id === project.ledModuleId) ?? preset.ledModules[0]
  const panelMaterial = preset.panelMaterials.find((m) => m.id === project.panelMaterialId) ?? preset.panelMaterials[0]
  const led = computeLed(layout.ledLengthMm, project.led, preset.psu)

  const pieces = acrylicPieces(layout.chars)
  const nesting = nestPieces(pieces, sheet.wMm, sheet.hMm, sheet.kerfMm, true)
  const pieceAreaM2 = nesting.totalPieceAreaMm2 / 1e6
  const outerPerimeterMm = layout.chars.reduce((s, c) => {
    const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
    return s + c.geom.outerPerimeter * k
  }, 0)
  const perimeterM = outerPerimeterMm / 1000
  const outlinePerimeterM =
    layout.chars.reduce((s, c) => {
      if (c.item.mode !== 'outline') return s
      const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
      return s + c.geom.outerPerimeter * k
    }, 0) / 1000
  const charCount = layout.chars.filter((c) => !c.missing && !c.blank).length

  const ctx = {
    areaM2: pieceAreaM2,
    chars: charCount,
    perimeterM,
    psu: led.psuCount,
    modules: led.modules,
    blocks: layout.chars.reduce((s, c) => s + (c.missing || c.blank ? 0 : c.geom.strokeBlocks), 0),
    outlinePerimeterM
  }

  const materials: Material[] = []
  // 1) 亚克力面板（按板计）
  materials.push({
    kind: 'acrylic',
    spec: sheet.spec,
    qty: nesting.sheetCount,
    unit: '张',
    unitPriceCents: sheet.priceCents,
    amountCents: nesting.sheetCount * sheet.priceCents
  })
  // 2) LED 模组
  if (panelMaterial.useLed) {
    materials.push({
      kind: 'led_module',
      spec: module.spec,
      qty: led.modules,
      unit: '只',
      unitPriceCents: module.priceCents,
      amountCents: led.modules * module.priceCents
    })
    // 3) 电源
    const psuUnitPrice = Math.round(preset.psu.pricePerWattCents * led.psuUnitW)
    materials.push({
      kind: 'psu',
      spec: `${preset.psu.spec} ${led.psuUnitW}W`,
      qty: led.psuCount,
      unit: '台',
      unitPriceCents: psuUnitPrice,
      amountCents: led.psuCount * psuUnitPrice
    })
  }
  // 4) 胶与配件（按各自计量口径取值；包边条仅描边/镂空字计）
  for (const c of preset.consumables) {
    const { qty, amountCents } = priceRuleItem(c.rule, c.unit, c.unitPriceCents, ctx)
    if (qty <= 0) continue
    materials.push({
      kind: 'glue',
      spec: c.spec,
      qty,
      unit: c.unit,
      unitPriceCents: c.unitPriceCents,
      amountCents
    })
  }
  // 5) 加工费（与「胶与配件」分组分开；不发光材质不计 LED 布点与电源装配）
  for (const l of preset.labor) {
    // LED 布点安装、电源装配只有发光方案才计
    if (!panelMaterial.useLed && (l.id === 'ledmount' || l.id === 'psuinstall')) continue
    const { qty, amountCents } = priceRuleItem(l.rule, l.unit, l.unitPriceCents, ctx)
    if (qty <= 0) continue
    materials.push({
      kind: 'labor',
      spec: l.spec,
      qty,
      unit: l.unit,
      unitPriceCents: l.unitPriceCents,
      amountCents
    })
  }

  const totalCents = materials.reduce((s, m) => s + m.amountCents, 0)
  const thin = layout.glyphs.filter((g) => !g.missing && g.minStrokeMm > 0 && g.minStrokeMm < project.layout.settings.strokeLimitMm)
  const blockReasons = [
    ...thin.map((g) => `「${g.char}」最细笔画 ${g.minStrokeMm}mm < 工艺下限 ${project.layout.settings.strokeLimitMm}mm`),
    ...nesting.oversize.map((p) => `料件「${p.label}」${p.wMm}×${p.hMm}mm 超过板材尺寸 ${sheet.wMm}×${sheet.hMm}mm`)
  ]
  const blocked = (blockReasons.length > 0 && !opts.acknowledgeThinStroke) || nesting.oversize.length > 0

  return {
    materials,
    totalCents,
    led,
    nesting,
    sheet,
    module,
    cutList: nesting.cutList,
    pieceAreaM2,
    outlinePerimeterM,
    blocked,
    blockReasons,
    panelMaterial
  }
}

/** 断言：Σ 材料金额 = 合计，金额均为整数分，且整件单位不出现小数件数 */
export function assertBomSum(bom: BomResult): { ok: boolean; message: string } {
  const sum = bom.materials.reduce((s, m) => s + m.amountCents, 0)
  const allInt = bom.materials.every((m) => Number.isInteger(m.amountCents))
  const noFractionalPieces = bom.materials.every((m) => !isPieceUnit(m.unit) || Number.isInteger(m.qty))
  const ok = sum === bom.totalCents && allInt && noFractionalPieces
  const tail = noFractionalPieces ? '通过' : '失败（存在小数件数）'
  return {
    ok,
    message: `Σ 明细 = ${sum} 分，合计 = ${bom.totalCents} 分；整数分校验：${allInt ? '通过' : '失败'}；整件取整校验：${tail}`
  }
}

/** 多材质成本对照（规格书第 5 节） */
export interface CompareRow {
  id: string
  name: string
  desc: string
  panelCents: number
  ledCents: number
  psuCents: number
  accessoryCents: number
  laborCents: number
  totalCents: number
}

export function compareMaterials(project: Project, layout: LayoutResult, preset: Preset, bom: BomResult): CompareRow[] {
  const pieceAreaM2 = bom.pieceAreaM2
  const perimeterM =
    layout.chars.reduce((s, c) => {
      const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
      return s + c.geom.outerPerimeter * k
    }, 0) / 1000
  const charCount = layout.chars.filter((c) => !c.missing && !c.blank).length
  const sumOf = (kind: Material['kind']): number => bom.materials.filter((m) => m.kind === kind).reduce((s, m) => s + m.amountCents, 0)
  const ledCents = sumOf('led_module')
  const psuCents = sumOf('psu')
  const accessoryCents = sumOf('glue')
  const laborTotal = sumOf('labor')

  return preset.panelMaterials.map((pm) => {
    // 当前选中方案：直接采用实际材料清单（与报价单完全一致，避免两套算法打架）
    if (pm.id === project.panelMaterialId) {
      return {
        id: pm.id,
        name: pm.name,
        desc: pm.desc,
        panelCents: sumOf('acrylic'),
        ledCents,
        psuCents,
        accessoryCents,
        laborCents: laborTotal,
        totalCents: bom.totalCents
      }
    }
    // 其它方案：按预设单价估算（不含 LED 的方案不计模组与电源）
    const panelCents = Math.round(
      pieceAreaM2 * pm.areaPriceCentsPerM2 + perimeterM * pm.perimeterPriceCentsPerM + charCount * pm.charLaborCents
    )
    const useLed = pm.useLed
    const led = useLed ? ledCents : 0
    const psu = useLed ? psuCents : 0
    const acc = useLed ? accessoryCents : Math.round(accessoryCents * 0.4)
    const labor = useLed ? laborTotal : Math.round(laborTotal * 0.55)
    return {
      id: pm.id,
      name: pm.name,
      desc: pm.desc,
      panelCents,
      ledCents: led,
      psuCents: psu,
      accessoryCents: acc,
      laborCents: labor,
      totalCents: panelCents + led + psu + acc + labor
    }
  })
}

/** 当前方案是否为「按实际材料清单」，用于界面标注 */
export function isActualRow(project: Project, row: CompareRow): boolean {
  return row.id === project.panelMaterialId
}

export function yuan(cents: number): string {
  return (cents / 100).toFixed(2)
}