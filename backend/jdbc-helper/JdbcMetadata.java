import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeMap;

/**
 * JDBC metadata introspection for the SCO Workbench Data Entity step.
 *
 * One helper for every read-only structure query the wizard needs, selected by a
 * single CLI argument (the "action"):
 *
 *   schemas   list the database's schemas                       → { ok, schemas:[…] }
 *   tables    list the tables/views in a given schema           → { ok, tables:[…] }
 *   columns   list a table's columns (name + type + PK flag)     → { ok, columns:[{name,dataType,primaryKey},…] }
 *
 * Reads a JSON object on stdin: { "dsn","username","password","driverClass", "schema"?, "table"? }.
 * Loads the requested JDBC driver (the driver JARs are on the classpath, supplied
 * by the Node backend), opens a real connection, and reads from the standard
 * `DatabaseMetaData` API — so it is database-agnostic (IRIS, PostgreSQL, …) with
 * no vendor-specific SQL. Prints a single JSON object on stdout; on any failure
 * prints { "ok": false, "message": "…" }.
 *
 * It never throws out of main — every outcome (including SQL/driver errors) is
 * reported as JSON so the Node side always gets a clean, parseable result. The
 * password is read from stdin (not argv) so it never appears in the process list.
 *
 * Deliberately dependency-free (no JSON library): the input is small and trusted
 * (produced by our own backend), so we do a tiny hand-rolled parse/escape.
 */
public class JdbcMetadata {
  public static void main(String[] args) {
    String action = args.length > 0 ? args[0] : "";
    try {
      String input = readAll();
      String dsn = jsonField(input, "dsn");
      String username = jsonField(input, "username");
      String password = jsonField(input, "password");
      String driverClass = jsonField(input, "driverClass");
      String schema = jsonField(input, "schema");
      String table = jsonField(input, "table");

      if (driverClass != null && !driverClass.isEmpty()) {
        // Explicit load helps when several drivers are on the classpath.
        Class.forName(driverClass);
      }

      // Fail fast rather than hang on an unreachable host.
      DriverManager.setLoginTimeout(10);

      try (Connection conn = DriverManager.getConnection(dsn, username, password)) {
        DatabaseMetaData meta = conn.getMetaData();
        switch (action) {
          case "schemas":
            printList("schemas", listSchemas(meta));
            break;
          case "tables":
            printList("tables", listTables(meta, schema));
            break;
          case "columns":
            printColumns(listColumns(meta, schema, table));
            break;
          default:
            printError("Unknown metadata action: \"" + action + "\".");
        }
      }
    } catch (ClassNotFoundException e) {
      printError("JDBC driver not found on the classpath: " + e.getMessage());
    } catch (Throwable e) {
      // SQLException (bad host/credentials) and anything else land here.
      String msg = e.getMessage();
      printError("Connection or authentication failed: " + (msg == null ? e.toString() : msg));
    }
  }

  /** All non-empty, non-system (`%`-prefixed) schema names. */
  private static List<String> listSchemas(DatabaseMetaData meta) throws Exception {
    List<String> out = new ArrayList<>();
    try (ResultSet rs = meta.getSchemas()) {
      while (rs.next()) {
        String name = rs.getString("TABLE_SCHEM");
        // Skip empty and IRIS system schemas (e.g. %SYS, %Dictionary).
        if (name != null && !name.isEmpty() && !name.startsWith("%")) out.add(name);
      }
    }
    return out;
  }

  /** Table + view names in a schema (excludes system tables, indexes, etc.). */
  private static List<String> listTables(DatabaseMetaData meta, String schema) throws Exception {
    List<String> out = new ArrayList<>();
    try (ResultSet rs = meta.getTables(null, schema, "%", new String[] { "TABLE", "VIEW" })) {
      while (rs.next()) {
        String name = rs.getString("TABLE_NAME");
        if (name != null && !name.isEmpty()) out.add(name);
      }
    }
    return out;
  }

  /**
   * A table's columns: name + JDBC type name (e.g. VARCHAR, INTEGER) + a
   * primary-key flag ("1"/"0"), in order.
   *
   * The PK flag drives the SQL pipeline's `KeyFieldName` (row-tracking column) so
   * the adapter processes each source row once — independent of the target
   * mapping. We take the table's declared PRIMARY KEY when there is one; if the
   * table has none (a view, or a keyless table), we fall back to a SINGLE-column
   * UNIQUE index (a composite/non-unique index is not a safe high-water mark, so
   * we don't use it). If neither exists, no column is flagged and the pipeline
   * runs with row-tracking disabled (re-reads every poll; the target upsert keeps
   * it idempotent).
   */
  private static List<String[]> listColumns(DatabaseMetaData meta, String schema, String table) throws Exception {
    Set<String> keyCols = detectKeyColumns(meta, schema, table);
    List<String[]> out = new ArrayList<>();
    try (ResultSet rs = meta.getColumns(null, schema, table, "%")) {
      while (rs.next()) {
        String name = rs.getString("COLUMN_NAME");
        String type = rs.getString("TYPE_NAME");
        if (name != null && !name.isEmpty()) {
          out.add(new String[] { name, type == null ? "" : type, keyCols.contains(name) ? "1" : "0" });
        }
      }
    }
    return out;
  }

  /**
   * The set of column names that form the table's row-tracking key: the declared
   * PRIMARY KEY if present, else the columns of a single-column UNIQUE index, else
   * empty. Returns the exact `COLUMN_NAME`s so the caller can flag them.
   *
   * A multi-column key is returned as-is (all its columns flagged); the pipeline
   * only USES a key when it resolves to exactly ONE selected column, so a
   * composite key naturally degrades to "no single key" downstream — safe.
   * Tolerant of drivers that don't support a given metadata call.
   */
  private static Set<String> detectKeyColumns(DatabaseMetaData meta, String schema, String table) {
    // 1. Declared primary key.
    Set<String> pk = new LinkedHashSet<>();
    try (ResultSet rs = meta.getPrimaryKeys(null, schema, table)) {
      while (rs.next()) {
        String col = rs.getString("COLUMN_NAME");
        if (col != null && !col.isEmpty()) pk.add(col);
      }
    } catch (Throwable ignore) {
      // driver may not support getPrimaryKeys — fall through to index probe
    }
    if (!pk.isEmpty()) return pk;

    // 2. No PK — look for a single-column UNIQUE index (non-unique=false).
    //    Group index columns by index name; keep the first unique index that has
    //    exactly one column.
    TreeMap<String, List<String>> uniqueIdx = new TreeMap<>();
    try (ResultSet rs = meta.getIndexInfo(null, schema, table, true /* unique only */, true /* approximate ok */)) {
      while (rs.next()) {
        boolean nonUnique = rs.getBoolean("NON_UNIQUE");
        if (nonUnique) continue;
        String idxName = rs.getString("INDEX_NAME");
        String col = rs.getString("COLUMN_NAME");
        if (idxName == null || col == null || col.isEmpty()) continue; // tableIndexStatistic row has null name/col
        uniqueIdx.computeIfAbsent(idxName, k -> new ArrayList<>()).add(col);
      }
    } catch (Throwable ignore) {
      // driver may not support getIndexInfo — no key detected
    }
    for (List<String> cols : uniqueIdx.values()) {
      if (cols.size() == 1) {
        Set<String> one = new LinkedHashSet<>();
        one.add(cols.get(0));
        return one;
      }
    }
    return new LinkedHashSet<>();
  }

  /** Read all of stdin as a UTF-8 string. */
  private static String readAll() throws Exception {
    StringBuilder sb = new StringBuilder();
    try (BufferedReader r = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
      int c;
      while ((c = r.read()) != -1) sb.append((char) c);
    }
    return sb.toString();
  }

  /**
   * Extract a top-level string field from a flat JSON object. Handles the escapes
   * our Node side emits (\\ \" \n \r \t). Adequate because the input is our own
   * JSON.stringify of a few string fields — not a general-purpose parser.
   */
  private static String jsonField(String json, String key) {
    String needle = "\"" + key + "\"";
    int k = json.indexOf(needle);
    if (k < 0) return "";
    int colon = json.indexOf(':', k + needle.length());
    if (colon < 0) return "";
    int i = colon + 1;
    while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
    if (i >= json.length() || json.charAt(i) != '"') return "";
    i++; // past opening quote
    StringBuilder val = new StringBuilder();
    while (i < json.length()) {
      char c = json.charAt(i);
      if (c == '\\' && i + 1 < json.length()) {
        char n = json.charAt(i + 1);
        switch (n) {
          case 'n': val.append('\n'); break;
          case 'r': val.append('\r'); break;
          case 't': val.append('\t'); break;
          case '"': val.append('"'); break;
          case '\\': val.append('\\'); break;
          case '/': val.append('/'); break;
          default: val.append(n);
        }
        i += 2;
      } else if (c == '"') {
        break;
      } else {
        val.append(c);
        i++;
      }
    }
    return val.toString();
  }

  /** Print a successful result whose payload is a JSON string array under `key`. */
  private static void printList(String key, List<String> values) {
    StringBuilder b = new StringBuilder();
    b.append("{\"ok\":true,\"").append(key).append("\":[");
    for (int i = 0; i < values.size(); i++) {
      if (i > 0) b.append(',');
      b.append('"').append(escape(values.get(i))).append('"');
    }
    b.append("]}");
    System.out.println(b.toString());
  }

  /** Print a successful columns result: [{ "name","dataType","primaryKey" }, …]. */
  private static void printColumns(List<String[]> columns) {
    StringBuilder b = new StringBuilder();
    b.append("{\"ok\":true,\"columns\":[");
    for (int i = 0; i < columns.size(); i++) {
      if (i > 0) b.append(',');
      String[] c = columns.get(i);
      boolean pk = c.length > 2 && "1".equals(c[2]);
      b.append("{\"name\":\"").append(escape(c[0]))
       .append("\",\"dataType\":\"").append(escape(c[1]))
       .append("\",\"primaryKey\":").append(pk ? "true" : "false").append('}');
    }
    b.append("]}");
    System.out.println(b.toString());
  }

  /** Print a failure result: an error message as JSON on stdout. */
  private static void printError(String message) {
    System.out.println("{\"ok\":false,\"message\":\"" + escape(message) + "\"}");
  }

  /** Escape a string for embedding in JSON. */
  private static String escape(String s) {
    if (s == null) return "";
    StringBuilder b = new StringBuilder();
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"': b.append("\\\""); break;
        case '\\': b.append("\\\\"); break;
        case '\n': b.append("\\n"); break;
        case '\r': b.append("\\r"); break;
        case '\t': b.append("\\t"); break;
        default:
          if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
          else b.append(c);
      }
    }
    return b.toString();
  }
}
