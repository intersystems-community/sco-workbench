# Reference: Request Message Class

> **In the normal deploy flow you do NOT hand-write this class — `sco_generate_integration_classes` produces it.** This reference documents WHAT that tool generates and why, for understanding/explaining or a rare chat-only exception. Do not author the class by hand for a payload-driven deploy.


Generate an SCO message class that carries the ingested data from the Business Service into the Business Process. In a data pipeline this is always an **`Ens.Request`** — the BS sends it in; the BP receives it as its `request` and the DTL reads it as its `sourceClass`.

You are generating source only. The pipeline compiles it in Step 7 via the compile-class skill — do **not** write files to disk or load it here.

## Rules

Based on the information provided by the user, determine whether the source file contains a header row:
* **If a header row exists:** Create the message according to the current rules, using the header values as property names.
* **If no header row exists:** Treat each property name provided by the user as a one-based column index. For each specified index, create a property named `Column` followed by the index value. For example, if the user provides `1` and `2`, the generated message properties are `Column1` and `Column2`.
When creating the message, always distinguish between these two scenarios based on whether the source file contains a header row.

## Properties

One `Property {Name} As {Type};` per distinct **source** field from the flow's field mappings — these are the fields the inbound data carries, which the DTL then maps onto the target. Use the exact casing the user gave. Default every property to `%String` unless the user specified a type:

| Short name | SCO type |
|---|---|
| `string` | `%String` |
| `integer` | `%Integer` |
| `decimal` | `%Decimal` |
| `boolean` | `%Boolean` |
| `date` | `%Date` |
| `datetime` | `%TimeStamp` |
| `time` | `%Time` |
| `stream` | `%Stream.GlobalCharacter` |

> **SQL adapter constraint:** if the pipeline uses the SQL adapter, the request property names must exactly match the query **columns** (GenericService) or the **output parameter names** (ProcService) — that's how the pre-built SQL service populates the typed message. Make sure the field list was collected to line up; if it can't, tell the user rather than silently letting the service fall back to untyped `Ens.StreamContainer`.

## Class template — generate EXACTLY this, nothing more

```objectscript
/// {description}
Class {packageName}.{className} Extends Ens.Request
{

{properties}

}
```

- `{description}` — omit the whole `/// ...` line if none was given.
- `{properties}` — one `Property {Name} As {Type};` per field, blank line between them.
- Split `{packageName}` / `{className}` from the fully-qualified `requestClass` (everything before the last dot is the package).

**NEVER add a `Storage` block / `XData` / `Parameter` / index to a message class.** The class body is ONLY the `Property` lines. `Ens.Request` (persistent) generates its own storage on compile — hand-writing a `Storage Default { ... }` block (or any `<Type>` guess) is the #1 cause of the message failing to compile with `ERROR #5559: … could not be parsed correctly` / `#5030`. Emit the class verbatim as above: class comment (optional), `Extends Ens.Request`, the properties, close brace. Nothing else.

Return the fully-qualified `requestClass` to the pipeline so the DTL and BP reference the same name.
