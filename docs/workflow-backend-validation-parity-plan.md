# Workflow Backend Validation Parity Plan

## Summary

UI'da workflow save, test ve publish oncesi calisan validation kurallarini backend'de de zorunlu hale getirecegiz. Hedef, UI bypass edilip raw API kullanilsa bile eksik flow, detached card, hatali trigger, hatali schema veya bozuk node shape backend'den gecmemesi.

Backend `GET` ve list endpointlerinde validation calistirmayacak. Eski veya bozuk kayitlar sayfayi kirmadan okunabilir kalacak. Ancak create, draft update, publish ve run aninda ayni validation uygulanacak.

## Milestone 1: Shared Validation Core

Goal: UI ve backend ayni semantic workflow validation kodunu kullansin.

### Slice 1.1: Graph Completeness Validator

- `@openacme/workflows` icine shared `validateWorkflowGraphCompleteness(nodes)` eklenecek.
- Entry node'dan baslayarak reachable executable node'lar bulunacak.
- `next`, `then`, `else`, `body`, `switch.cases/default` ve `parallel.branches` takip edilecek.
- Detached executable card varsa invalid sonuc uretilecek.
- Detached `builtin.exit`, UI davranisiyla uyumlu sekilde completeness disinda kalacak.

TDD:

- `A -> B` ve detached `C` invalid olmali.
- `A -> B -> C` valid olmali.
- Detached `builtin.exit` valid kalmali.
- `if` true/false child node'lari reachable sayilmali.
- `switch` case/default child node'lari reachable sayilmali.
- `parallel` branch child node'lari reachable sayilmali.
- `foreach.body` child node'lari reachable sayilmali.

### Slice 1.2: Authoring Validator

- Shared `validateWorkflowDefinitionAuthoring(definition)` eklenecek.
- Tek noktadan sunlari calistiracak:
  - schema parse ve normalize sonrasi validation
  - node reference validation
  - graph completeness validation
  - trigger validation
  - workflow ve trigger JSON Schema validation

TDD:

- Invalid trigger id/path reject edilmeli.
- Duplicate node id reject edilmeli.
- Missing node reference reject edilmeli.
- Detached card reject edilmeli.
- Valid many-card workflow accept edilmeli.

## Milestone 2: Backend Enforcement

Goal: UI bypass edilse bile backend invalid workflow kabul etmesin.

### Slice 2.1: Create/Update Enforcement

- `POST /workflows` create oncesi full candidate validate edilecek.
- `PATCH /workflows/:id` icin mevcut draft ile patch merge edilip final candidate validate edilecek.
- Validation, store'a yazilacak normalized graph ile ayni candidate uzerinde calisacak.
- Error format geriye uyumlu kalacak: `{ "error": "message", "issues": [...] }`.

TDD:

- Detached node iceren create `400` donmeli.
- Detached node olusturan patch `400` donmeli.
- Sadece name update, mevcut graph valid ise `200` donmeli.
- Mevcut graph invalid ise patch reject edilmeli; kullanici once flow'u duzeltmeli.

### Slice 2.2: Publish/Run Enforcement

- Publish oncesi ayni authoring validator kosacak.
- Test/live run baslamadan ayni authoring validator kosacak.
- Invalid run icin execution kaydi olusturulmayacak.

TDD:

- Invalid workflow publish `400` donmeli.
- Invalid workflow test run `400` donmeli.
- Invalid workflow live run `400` donmeli.
- Valid workflow run kaydi olusturmali ve step execution baslamali.

## Milestone 3: UI Parity Cleanup

Goal: UI validation mesajlari korunurken duplicate semantic logic azaltilsin.

### Slice 3.1: UI Shared Validator Usage

- UI'daki local graph completeness logic shared package'dan kullanilacak.
- UI save/test/publish davranisi degismeyecek.
- User-facing message korunacak:
  - `Workflow flow is incomplete. Connect or remove unreachable card(s): ...`

TDD:

- Detached card save blocked olmali.
- Valid graph save allowed olmali.
- UI backend'den gelen ayni validation message'i gosterebilmeli.

### Slice 3.2: API Error Display

- Backend'den gelen validation error UI'da mevcut toast/form error mekanizmasiyla gosterilecek.
- `issues` varsa detayli debug icin saklanacak, ama ana kullanici mesaji `error` olacak.

TDD:

- Backend `400 { error }` dondugunde UI ayni mesaji gostermeli.
- `issues` presence UI'yi kirmamali.

## Milestone 4: Regression and Safety

Goal: Mevcut workflow'lari okumayi kirmadan, yazma ve calistirma tarafinda strict validation saglamak.

### Slice 4.1: GET/List Non-Enforcement

- `GET /workflows`, workflow detail ve list endpointleri validation calistirmayacak.
- Eski invalid kayitlar UI'da acilabilir.
- Ayni kayit save, publish veya run sirasinda reject edilir.

TDD:

- Invalid stored workflow GET ile donebilmeli.
- Ayni workflow publish/run sirasinda reject edilmeli.

### Slice 4.2: Complex Workflow Regression

- Many Cards Smoke Test benzeri complex graph fixture'i eklenecek.
- Fixture icinde `if`, `switch`, `foreach`, `parallel`, transformer, log ve sleep path'leri olacak.
- Backend authoring validator'dan gecmeli.

TDD:

- Fixture validate success olmali.
- Fixture create/update success olmali.
- Fixture run baslatilabilir olmali.

## Acceptance Criteria

- UI'nin save/test/publish sirasinda engelledigi workflow state'leri raw API ile de kaydedilemez.
- Detached veya bind edilmemis executable card backend'de reject edilir.
- Missing reference, duplicate id, invalid trigger ve invalid schema backend'de reject edilir.
- Existing invalid workflows okunabilir kalir.
- Backend ve UI ayni shared validation kaynaklarini kullanir.
- Test suite invalid/valid graph davranisini acikca kapsar.

## Implementation Notes

Implemented in this slice:

- Shared workflow graph completeness validation lives in `@openacme/workflows`.
- Shared authoring validation now combines node references, graph completeness, triggers, and workflow/trigger JSON Schema checks.
- Backend create, draft update, publish, and run paths call the shared authoring validator before persisting or starting execution.
- Draft update validation runs on the merged current draft plus patch candidate, not only on fields present in the patch.
- Workflow reads and lists remain non-blocking and do not validate existing persisted definitions.
- The workflow UI now delegates canvas completeness checks to the shared graph completeness validator while preserving the existing UI message.
- Whitespace-only workflow names, scheduled cron expressions, and webhook paths are rejected on the backend to match UI trim-based validation.

Validation evidence:

- `pnpm --filter @openacme/workflows exec vitest run test/schemas.test.ts`
- `pnpm --filter @openacme/workflows check-types`
- `pnpm --filter @openacme/server exec vitest run test/workflow-routes.test.ts`
- `pnpm --filter @openacme/server check-types`
- `pnpm --filter web check-types`

Remaining follow-up:

- Broaden UI component-level test coverage around the shared validation adapter if a stable workflow UI test harness is added.
- Consider returning structured `issues` in API responses after confirming existing clients do not rely on exact `{ error }` response bodies.

## Assumptions

- Backward compatibility hedef degil; UI'nin izin vermedigi workflow state'i backend de kabul etmeyecek.
- Strict validation draft save asamasinda da gecerli olacak.
- `builtin.exit` canvas'ta gorunmeyen backend terminal node olarak kalabilir; detached olmasi completeness error uretmeyecek.
