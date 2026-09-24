# Reference: BPL Business Process (runs the DTL, persists the target)

> **In the normal deploy flow you do NOT hand-write this class — `sco_generate_integration_classes` produces it** (one `<code>` block: upsert via `<keyIndex>Open` → `Transform` → `%Save()`, with a `<catchall>`). This reference documents what the tool generates and why. Author by hand only in a rare chat-only exception.


Generate one specific shape of BPL Business Process (`Ens.BusinessProcessBPL`): it receives the inbound `requestClass`, **opens the existing target row by its unique key (or makes a new one if absent)**, invokes the DTL's `Transform` to map onto it, and `%Save()`s it. This is the piece that actually *executes* the mapping and persists the result — the DTL only *defines* the rules; it neither runs itself nor saves anything.

```
inbound request ──► <scope>: <code> open-or-new target by key → DTL.Transform(request,.target) → target.%Save() ──► ends OK
                          └─ on error ──► <catchall>: <code> $$$LOGERROR (Event Log), skip request, continue
```

The open-or-new step is what makes the pipeline **idempotent (upsert)**: re-running it updates the existing row instead of failing on the unique-key index with `#5808 Key not unique`.

You are generating source only — the pipeline compiles it in Step 7. Do not write files to disk here.

## Generate the template EXACTLY — do not improvise the BPL structure

**Use the class template below verbatim** (substituting only the `{…}` placeholders). Do NOT design your own BPL. Getting this wrong produces a process that compiles but then terminates on the FIRST message with a runtime error — the worst kind, because deploy reports success and only the production Event Log shows the failure. The mistakes below are real ones that have shipped; avoid every one:

- **NEVER write to `context.<anything>` unless you declared it in a `<context>` block.** A BPL's `context` only has the properties you declare; assigning `context.targetObject` (or reading it) without a `<context><property name='targetObject' .../></context>` throws `<PROPERTY DOES NOT EXIST>` at runtime on every message and terminates the BP (`ERROR <Ens>ErrBPTerminated`). **This template deliberately uses a plain local variable `tTarget` inside one `<code>` block instead of a context property — keep it that way.** Do not add a `<transform>` element that targets `context.targetObject`; do the DTL call inside the `<code>` block as shown.
- **Do the open-or-new upsert, the `Transform`, and the `%Save()` inside ONE `<code>` block** (as templated). Do not split them into a `<transform>` activity plus a separate `<code>` save — that path is what tempts you into an undeclared `context.targetObject` and loses the upsert (it always `%New()`s and then fails the unique key with `#5808` on re-run).
- **Do not invent activities** (`<call>`, `<assign>` to context, extra `<transform>`s). The whole process is one `<scope>` containing one `<code>` and a `<faulthandlers><catchall>`. Nothing else.
- **NEVER invoke the DTL with a `<call target='…DTL…'>` activity.** A DTL is NOT a registered business host — a `<call>` routes by config-item name through the production dispatcher, so calling a DTL class name fails at runtime with `ERROR <Ens>ErrBusinessDispatchNameNotRegistered: Business dispatch name '…Transformation' is not registered to run` and terminates the BP on every message. `<call>` is only for calling another **Business Operation/Process** by its config name. The DTL is invoked as a plain classmethod — `##class({dtlClass}).Transform(request, .tTarget)` — inside the `<code>` block, exactly as templated. There is no config item for the DTL and you must not create one.
- **NEVER hand-write a `Storage` block / `XData` other than `XData BPL`.** `Ens.BusinessProcessBPL` is persistent and generates its own storage on compile. Writing your own `Storage Default { <Type>%Storage.Persistent</Type> }` fails to compile with `ERROR #5478: Keyword signature error … keyword 'Type' must be '%Storage.Persistent' or its subclass`. Keep the `[ ClassType = persistent ]` class keyword (it's in the template); add NO Storage block. The only `XData` in the class is `XData BPL`.

## Inputs (passed by the pipeline — do not re-prompt)
- `packageName` / `processName` (from `bpConfigName`, e.g. `SC.Workbench.Integration{id}.BP` / `CustomerProcess`)
- `requestClass` — must equal the DTL `sourceClass`.
- `dtlClass` — the DTL to invoke.
- `targetClass` — must equal the DTL `targetClass`.
- `keyIndex` / `keyRequestProp` — the target's **key index name** and the **request property** holding that key's
  value (e.g. index `uidIndex` on `SC.Data.Customer`, from `request.ID`). The pipeline determines these in Step 2 when it
  verifies the target's indices. `<keyIndex>Open(value)` is the class method SCO generates for an index — it
  returns the existing object or `""`.
  - **Verify the `<keyIndex>Open` method actually exists before using it** (Step 2 does this with `sco_list_methods`).
    SCO generates `<index>Open` for indices flagged for it — for SCO's `SC.Data.*` classes this includes the `<prop>Index`
    on the natural key (e.g. `uidIndexOpen` exists on `SC.Data.Customer`), **even though that index is not marked
    `unique`**. So pick the key index by NAME + the presence of its `Open` method, NOT by the `unique` flag — if you gate
    on `unique=1` you'll wrongly conclude there's no key and fall back to insert-only. If NO `<index>Open` method exists on
    the target, then fall back to insert-only (always `%New()`), and warn the user that re-runs will duplicate rows.

Validate all three class names are fully qualified (contain a dot); if any is bare, confirm the full name — don't guess.

## Class template

```objectscript
/// {description}
Class {packageName}.{processName} Extends Ens.BusinessProcessBPL [ ClassType = persistent ]
{

XData BPL [ XMLNamespace = "http://www.intersystems.com/bpl" ]
{
<process language='objectscript' request='{requestClass}' height='2000' width='2000' >
<sequence xend='200' yend='400' >
  <scope name='Transform and save {targetShort}' xpos='200' ypos='250' >
    <code name='Transform and save' xpos='200' ypos='350' >
      <![CDATA[
        // Upsert: open the existing target by its unique key, or make a new one.
        Set tTarget = ##class({targetClass}).{keyIndex}Open(request.{keyRequestProp})
        If '$IsObject(tTarget) { Set tTarget = ##class({targetClass}).%New() }
        Set status = ##class({dtlClass}).Transform(request, .tTarget)
        If $$$ISOK(status) { Set status = tTarget.%Save() }
        If $$$ISERR(status) { Throw ##class(%Exception.StatusException).CreateFromStatus(status) }
      ]]>
    </code>
    <faulthandlers>
      <catchall xpos='200' ypos='450' >
        <code name='Log skipped request' xpos='200' ypos='550' >
          <![CDATA[
            Do ##class(Ens.Util.Log).LogError($classname(), "OnFailure", "Skipped request - "_$System.Status.GetErrorText(..%Context.%LastError))
          ]]>
        </code>
      </catchall>
    </faulthandlers>
  </scope>
</sequence>
</process>
}

}
```

## Why it's built this way
- **`{keyIndex}Open(request.{keyRequestProp})` then fall back to `%New()`** — the upsert. SCO generates a
  `<indexName>Open(value)` class method for the key index (confirmed present in Step 2 via `sco_list_methods` — do not
  assume it from the `unique` flag); it returns the stored object for that key, or `""`
  when none exists. Opening-or-new'ing here (instead of always `%New()`) is what lets a re-run update the existing row
  rather than fail its unique key with `#5808`. This pairs with the DTL's `create='existing'`: the DTL maps onto the
  object the BPL hands it. The mapping MUST still set the key property, so a genuinely new row gets its key.
- **`Transform(request, .tTarget)`** — the DTL classmethod maps each `request` property onto the target you pass in.
- **`tTarget.%Save()`** — persistence. Building/opening an object never stores it; `%Save()` is what writes it.
- **`Throw ... CreateFromStatus(status)`** — a failed `status` inside a bare `<code>` would immediately terminate the whole BPL. Throwing routes control to the `<catchall>` instead, keeping the process alive for the next request.
- **NEVER `Quit <value>` inside a BPL `<code>` block.** BPL `<code>` is code-generated into a thread method that returns nothing, so `Quit tSC` (or any `Quit` with an argument) fails to compile (`Failed: … RETURN/QUIT with argument`). Use `Throw` to signal an error (routed to the `<catchall>`); a bare `Quit`/no `Quit` to finish normally. This is a compile-time trap the template already avoids — don't reintroduce it.
- **`<catchall>` + `<code>` `LogError`** — catches the error and writes its code + text to the Event Log via
  `Ens.Util.Log.LogError` (`..%Context.%LastError` holds the failing `%Status`), then the scope ends and the process
  returns **OK**: the one bad request is skipped and logged, overall ingestion continues. Use `LogError` (a `<code>`
  call), NOT `<trace>` — trace output is only recorded when trace logging is enabled on the host, so a `<trace>` here
  would silently drop the error on a normally-configured production. `<catchall>` must be the last fault handler.
  **Foreign-key-aware skip logging:** when the target has foreign keys this pipeline writes, the generator makes the
  catchall branch on a `#5829` (referential-integrity) failure and log the exact missing reference + the source value
  that had no matching parent row (e.g. "foreign-key reference not found: [SC.Data.Location: primaryLocationId='LOC-99']")
  — so the Event Log says WHICH parent row is absent, not just a generic "Skipped request". A `#5829` is a data
  prerequisite (load the referenced/parent table first), never a reason to loosen the target class.
- `[ ClassType = persistent ]` — BPL processes are persistent; keep it.
- `{targetShort}` — the target class name after the last dot; `{description}` line omitted if none.

Return the fully-qualified `{packageName}.{processName}` (= `bpConfigName`) to the pipeline. To receive traffic, this BP's config Name in the production must equal the upstream BS's `targetHost` — the pipeline guarantees this by registering it under its full class name.
