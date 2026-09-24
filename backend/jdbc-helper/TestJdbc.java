import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;

/**
 * Minimal JDBC connection tester for the SCO Workbench "Test Connection" button.
 *
 * Reads a JSON object on stdin: { "dsn", "username", "password", "driverClass" }.
 * Loads the requested JDBC driver (the driver JARs are on the classpath, supplied
 * by the Node backend), opens a real connection, runs `SELECT 1`, and prints a
 * single JSON object on stdout: { "ok": true|false, "message": "..." }.
 *
 * It never throws out of main — every outcome (including SQL/driver errors) is
 * reported as JSON so the Node side always gets a clean, parseable result. The
 * password is read from stdin (not argv) so it never appears in the process list.
 *
 * Deliberately dependency-free (no JSON library): the input is small and trusted
 * (produced by our own backend), so we do a tiny hand-rolled parse/escape.
 */
public class TestJdbc {
  public static void main(String[] args) {
    try {
      String input = readAll();
      String dsn = jsonField(input, "dsn");
      String username = jsonField(input, "username");
      String password = jsonField(input, "password");
      String driverClass = jsonField(input, "driverClass");

      if (driverClass != null && !driverClass.isEmpty()) {
        // Explicit load helps when several drivers are on the classpath.
        Class.forName(driverClass);
      }

      // Fail fast rather than hang on an unreachable host.
      DriverManager.setLoginTimeout(10);

      try (Connection conn = DriverManager.getConnection(dsn, username, password);
           Statement st = conn.createStatement();
           ResultSet rs = st.executeQuery("SELECT 1")) {
        rs.next(); // pull a row to prove the query executed
        print(true, "Connected to " + dsn + " as " + username + "; test query succeeded.");
      }
    } catch (ClassNotFoundException e) {
      print(false, "JDBC driver not found on the classpath: " + e.getMessage());
    } catch (Throwable e) {
      // SQLException (bad host/credentials/SQL) and anything else land here.
      String msg = e.getMessage();
      print(false, "Connection or authentication failed: " + (msg == null ? e.toString() : msg));
    }
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
   * JSON.stringify of four string fields — not a general-purpose parser.
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

  /** Print the result as a JSON object on stdout. */
  private static void print(boolean ok, String message) {
    System.out.println("{\"ok\":" + ok + ",\"message\":\"" + escape(message) + "\"}");
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
