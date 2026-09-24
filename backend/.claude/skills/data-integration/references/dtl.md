# Reference: DTL Data Transformation

> **In the normal deploy flow you do NOT hand-write this class — `sco_generate_integration_classes` produces it** (`create='existing'`, one `<assign>` per mapping, transforms applied). This reference documents what the tool generates and why. Author by hand only in a rare chat-only exception.


A DTL (`Ens.DataTransformDTL`) is an ObjectScript class whose `XData` holds XML describing field-level transformations from a source object to a target object. In this pipeline it maps `requestClass` (source) onto the pre-existing `targetClass` (target).

You are generating source only — the pipeline compiles it in Step 7. Do not write files to disk here.

> **Compile-time dependency:** the DTL's `Transform` method is produced by a code generator that reads the `sourceClass` and `targetClass` definitions *at compile time*. Both must be compiled in SCO **before** the DTL, or it fails with `ERROR #5001 <CLASS DOES NOT EXIST>` / `#5490`. The pipeline sequences this (request message first, target pre-existing, DTL after) — just generate correct source here.

## Class template

```objectscript
/// {description}
Class {packageName}.{className} Extends Ens.DataTransformDTL
{

Parameter IGNOREMISSINGSOURCE = 1;

Parameter REPORTERRORS = 1;

XData DTL [ XMLNamespace = "http://www.intersystems.com/dtl" ]
{
<transform sourceClass='{sourceClass}' targetClass='{targetClass}' create='existing' language='objectscript' >
  {actions}
</transform>
}

}
```

- `sourceClass` = `requestClass`; `targetClass` = the verified target class.
- **`create='existing'` (upsert), NOT `'new'`.** With `create='new'` the DTL always builds a brand-new target and the
  BPL inserts it — so re-running the pipeline on any id that already exists fails the target's unique/primary-key index
  with `ERROR #5808: Key not unique`, and that record is skipped. `create='existing'` instead means **the BPL supplies
  the target object** (it opens the row by its unique key, or makes a new one if absent — see [bpl.md](bpl.md)), and the
  DTL maps onto whatever it's handed. That makes a second run **update** the existing row in place instead of colliding.
  Always map the unique-key property (e.g. `target.uid`) so the saved row matches the one that was opened.
- Omit the `/// ...` line if no description.
- Keep both parameters. `IGNOREMISSINGSOURCE = 1` tolerates absent source fields; `REPORTERRORS = 1` surfaces mapping errors.

## Building `{actions}` from the field mappings

Translate each source→target field pair into action XML. For a plain object-to-object pipeline the workhorse is `<assign>`; use `<if>` / `<foreach>` / `<code>` when the mapping needs a condition, a loop, or logic that doesn't fit one expression. Property paths are simple dotted names on object classes: `source.customerId`, `target.name`.

### `<assign>` — set a target field

```xml
<assign value='source.customerId' property='target.id' action='set' />
<assign value='..ToUpper(source.name)' property='target.name' action='set' />
<assign value='"ACTIVE"' property='target.status' action='set' />
```

- `property` — required, the target field path.
- `value` — required, an ObjectScript expression or a quoted string literal (`'"ACTIVE"'`).
- `action` — default `set`. For object targets, also `append`/`insert` (list properties, `key` required), `remove`, `clear`.

### `<if>` — conditional

```xml
<if condition='source.status="A"'>
  <true><assign property='target.active' value='1' action='set' /></true>
  <false><assign property='target.active' value='0' action='set' /></false>
</if>
```

Either `<true>` or `<false>` may be omitted. Inside them: any of `<assign>`, `<code>`, `<if>`, `<foreach>`.

### `<foreach>` — iterate a collection/repeating field

```xml
<foreach property='source.lines()' key='i'>
  <assign property='target.lines.(i).sku' value='source.lines.(i).sku' action='set' />
</foreach>
```

`property` = the collection to iterate; `key` = the loop variable used inside.

### `<code>` — raw ObjectScript (multi-field or logic that doesn't fit an expression)

```xml
<code>
  <![CDATA[ set target.fullName = source.firstName _ " " _ source.lastName ]]>
</code>
```

No attributes; language comes from `<transform language>`. Always wrap in `<![CDATA[ ... ]]>`.

## Transform functions (`..` prefix)

**Use ONLY these. Inventing a function name causes a compile error — they do not exist.**

| Function | Purpose | Example |
|---|---|---|
| `..ToUpper(val)` | uppercase | `..ToUpper(source.name)` |
| `..ToLower(val)` | lowercase | `..ToLower(source.code)` |
| `..ConvertDateTime(val,inFmt,outFmt)` | reformat date/time | `..ConvertDateTime(source.dob,"%Y%m%d","%Y-%m-%d")` |
| `..ReplaceStr(val,old,new)` | replace substring | `..ReplaceStr(source.phone,"-","")` |
| `..SubString(val,start,end)` | substring (1-based) | `..SubString(source.code,1,3)` |
| `..Strip(val,mask,chars)` | strip chars | `..Strip(source.name,"<>"," ")` |
| `..Pad(val,length,char)` | pad (neg length = left) | `..Pad(source.id,-10,"0")` |
| `..Lookup(table,key)` | lookup table | `..Lookup("Status",source.status)` |
| `..Piece(val,delim,from,to)` | delimited piece(s) | `..Piece(source.full,":",1)` |
| `..Length(val)` | string length | `..Length(source.name)` |

For a first-non-empty coalesce, use plain ObjectScript: `$SELECT(source.a="":source.b,1:source.a)`.

### Mapping the workbench payload's `transformArgs` onto these functions
When a mapping comes from the Data Integration UI, each row carries `transform` (the function name) and `transformArgs` (a **named** object). The source field is always the implicit first argument (`val`); the named keys fill the remaining **positional** arguments in this order:

| `transform` | `transformArgs` keys (in order) | Generated call |
|---|---|---|
| `ToUpper` / `ToLower` / `Length` | *(none)* | `..ToUpper(source.field)` |
| `SubString` | `start`, `end` | `..SubString(source.field, start, end)` |
| `ReplaceStr` | `old`, `new` | `..ReplaceStr(source.field, old, new)` |
| `Strip` | `mask`, `chars` | `..Strip(source.field, mask, chars)` |
| `Pad` | `length`, `char` | `..Pad(source.field, length, char)` |
| `ConvertDateTime` | `inFmt`, `outFmt` | `..ConvertDateTime(source.field, inFmt, outFmt)` |
| `Piece` | `delim`, `from`, `to` | `..Piece(source.field, delim, from, to)` |
| `Lookup` | `table`, `key` | `..Lookup(table, key)` |

Quote string arguments as ObjectScript literals (`"-"`, `"%Y%m%d"`); pass numeric ones bare. An empty/absent `transform` means a plain `<assign value='source.field' …>` with no function.

**XML-escape the `value` attribute** — it's single-quoted, so write `<`/`>`/`&` as `&lt;`/`&gt;`/`&amp;`, and avoid a literal `'` inside it (prefer expression forms that don't need one, e.g. `$SELECT(a="":b,1:a)`).

### ConvertDateTime format codes
`%Y` 4-digit year · `%m` month 01-12 · `%d` day · `%H` hour 00-23 · `%M` minute · `%S` second. E.g. `"20260429"` with in-format `"%Y%m%d"` → out-format `"%Y-%m-%d"` gives `"2026-04-29"`.

### Strip mask / Pad detail
Strip mask: `"*"` all occurrences · `"<"` leading only · `">"` trailing only · `"<>"` both ends (chars to strip are the 3rd arg). Pad: positive length pads right, negative pads left.

Return the fully-qualified `dtlClass` to the pipeline.
