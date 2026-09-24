# JDBC driver JARs

Drop the JDBC driver JAR(s) for the databases the Data Integration **Test
Connection** should support into this directory. They are **not committed**
(licensed / large — see `.gitignore`); the operator supplies them.

The backend launches the Java helper (`../jdbc-helper/TestJdbc.java`) with every
`*.jar` in this directory on its classpath and loads the driver by class name at
runtime — so adding another database is just: drop its driver JAR here + add the
driver class to the frontend's database-type → driver map.

| Database          | Driver JAR (example)      | Driver class                       |
|-------------------|---------------------------|------------------------------------|
| InterSystems IRIS | `intersystems-jdbc-*.jar` | `com.intersystems.jdbc.IRISDriver` |
| PostgreSQL        | `postgresql-*.jar`        | `org.postgresql.Driver`            |

## Docker (baked into the image)

Place the JAR(s) here **before** `docker build`. The Dockerfile `COPY`s this
directory into the image at `/app/backend/jdbc-lib` (the default `JDBC_LIB_DIR`),
so a container built from that image has JDBC ready with no runtime step.

To add or update a driver, drop the new JAR here and rebuild the image.

## Local `npm run dev`

Place the JAR(s) here and ensure a JRE is on your PATH (`JAVA_BIN`, default
`java`). Without a JRE the test degrades to a clear "Java runtime not available"
message — the rest of the app still runs.
