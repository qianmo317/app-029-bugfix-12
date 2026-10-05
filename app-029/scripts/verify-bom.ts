import materialsData from './src/data/materials.json'
import { buildBom, assertBomSum, defaultPreset, isPieceUnit, ruleQuantity, type Preset } from './src/logic/materials'
import type { Project } from './src/logic/types'

const preset = materialsData as unknown as Preset

// 构造一个最小的假 LayoutResult：3 个字，每字 2 个笔画块，外接矩形 200×200mm，外周长 1600mm
function fakeLayout(useOutline: boolean) {
  const chars = ['招', '牌', '字'].map((ch, i) => ({
    char: ch,
    x: i * 300,
    y: 0,
    inkW: 200,
    inkH: 200,
    missing: false,
    blank: false,
    gapAfter: null,
    item: { char: ch, trackMm: 0, offsetYMm: 0, mode: useOutline ? 'outline' : 'solid', line: 0 },
    geom: {
      inkW: 200,
      inkH: 200,
      blockBBoxes: [
        { x0: 0, y0: 0, x1: 200, y1: 100 },
        { x0: 0, y0: 100, x1: 200, y1: 200 }
      ],
      outerPerimeter: 1600,
      strokeBlocks: 2
    }
  }))
  return {
    chars,
    glyphs: chars.map((c) => ({ char: c.char, missing: false, minStrokeMm: 20, warnings: [] })),
    ledLengthMm: 3 * 1600,
    occupiedW: 900,
    occupiedH: 200
  } as any
}

function makeProject(panelMaterialId: string): Project {
  return {
    id: 't',
    name: '测试',
    panelMaterialId,
    sheetId: 'acr-1220x2440x3',
    ledModuleId: 'led-12v-072-60',
    led: { moduleSpacingMm: 150, modulePowerW: 0.72, moduleLumen: 60, safetyFactor: 1.2, psuEfficiency: 0.85 },
    layout: { settings: { strokeLimitMm: 8 } } as any,
    createdAt: 0,
    updatedAt: 0
  } as Project
}

function dump(title: string, bom: any) {
  console.log(`\n===== ${title} =====`)
  for (const m of bom.materials) {
    console.log(`${String(m.kind).padEnd(10)} ${m.spec.padEnd(42)} qty=${String(m.qty).padEnd(8)} ${m.unit}  金额=${m.amountCents} 整件单位=${isPieceUnit(m.unit)}`)
  }
  console.log('合计:', bom.totalCents)
  console.log(assertBomSum(bom).message)
}

// 1) 发光字（实体）
const p1 = makeProject('acrylic_led')
const b1 = buildBom(p1, fakeLayout(false), preset)
dump('亚克力发光字（实体，3 字）', b1)

// 2) 不发光材质
const p2 = makeProject('pvc')
const b2 = buildBom(p2, fakeLayout(false), preset)
dump('PVC 不发光字（3 字）', b2)

// 3) 描边字（outline）→ 应有包边条
const b3 = buildBom(p1, fakeLayout(true), preset)
dump('亚克力发光字（描边，3 字）→ 应含包边条', b3)

// 4) 单元规则测试
const ctx0 = { areaM2: 0, chars: 0, perimeterM: 0, psu: 0, modules: 0, blocks: 0, outlinePerimeterM: 0 }
const glueRule = preset.consumables.find((c) => c.id === 'glue')!.rule
console.log('\n零用量 + 起订量1（结构胶）:', ruleQuantity(glueRule, '支', ctx0)) // 期望 1
const screwRule = preset.consumables.find((c) => c.id === 'screw')!.rule
console.log('零用量 + 起订量0（螺丝）:', ruleQuantity(screwRule, '套', ctx0)) // 期望 0
const cutRule = preset.labor.find((l) => l.id === 'cut')!.rule
console.log('面积折算（㎡，0.24㎡）:', ruleQuantity(cutRule, '㎡', { ...ctx0, areaM2: 0.24 })) // 0.24 保留小数
const trimRule = preset.consumables.find((c) => c.id === 'trim')!.rule
console.log('包边条（描边周长 5.04m ×1.05）:', ruleQuantity(trimRule, '米', { ...ctx0, outlinePerimeterM: 5.04 }))
console.log('包边条无描边字时:', ruleQuantity(trimRule, '米', ctx0)) // 0 → 不计

// 4b) 七种计量口径逐个验证（基数各不相同，不再都跟字数走）
const ctxFull = { areaM2: 1.5, chars: 7, perimeterM: 20, psu: 3, modules: 40, blocks: 30, outlinePerimeterM: 12 }
const mkRule = (type: any, value = 1, minQty = 0) => ({ type, value, minQty })
const cases: Array<[any, number]> = [
  ['perPieceAreaM2', 1.5],
  ['perChar', 7],
  ['perMeterPerimeter', 20],
  ['perPsu', 3],
  ['perModule', 40],
  ['perStrokeBlock', 30],
  ['perOutlinePerimeter', 12]
]
for (const [type, want] of cases) {
  const got = ruleQuantity(mkRule(type), '米', ctxFull)
  console.log(`口径 ${type}: 期望 ${want}，实得 ${got}`, got === want ? '✓' : '✗')
  if (got !== want) process.exitCode = 1
}
// perModule 整件取整（系数 0.1 → 4 个向上取整；若按旧逻辑 chars 会得 1）
const perModulePiece = ruleQuantity(mkRule('perModule', 0.1), '个', ctxFull)
console.log('按模组折算整件（40×0.1=4 个）:', perModulePiece, perModulePiece === 4 ? '✓' : '✗')
if (perModulePiece !== 4) process.exitCode = 1
// perPsu 整件：3 台电源 → 每台 1 项 = 3 台
const perPsu = ruleQuantity(mkRule('perPsu', 1), '台', ctxFull)
console.log('按电源台数（3 台）:', perPsu, perPsu === 3 ? '✓' : '✗')
if (perPsu !== 3) process.exitCode = 1

// 5) 断言
const errors: string[] = []
for (const m of [...b1.materials, ...b2.materials, ...b3.materials]) {
  if (isPieceUnit(m.unit) && !Number.isInteger(m.qty)) errors.push(`小数件数: ${m.spec} qty=${m.qty}`)
}
if (b2.materials.some((m) => m.kind === 'led_module' || m.kind === 'psu')) errors.push('PVC 方案出现 LED/电源材料行')
if (b2.materials.some((m) => m.spec.includes('LED 布点') || m.spec.includes('电源装配'))) errors.push('PVC 方案计了 LED 布点/电源装配费')
if (!b3.materials.some((m) => m.spec.includes('包边条'))) errors.push('描边字缺少包边条')
if (b1.materials.some((m) => m.spec.includes('包边条'))) errors.push('实体字不该有包边条')
if (b1.materials.filter((m) => m.kind === 'labor').length === 0) errors.push('加工费未分组为 labor')
if (b1.materials.filter((m) => m.kind === 'glue').some((m) => m.spec.includes('切割'))) errors.push('加工费被并入胶与配件')
const s1 = assertBomSum(b1)
const s2 = assertBomSum(b2)
const s3 = assertBomSum(b3)
if (!s1.ok || !s2.ok || !s3.ok) errors.push('合计断言失败')
console.log('\n==== 结果 ====')
console.log(errors.length ? 'FAIL:\n' + errors.join('\n') : 'ALL CHECKS PASS')
if (errors.length) process.exit(1)
