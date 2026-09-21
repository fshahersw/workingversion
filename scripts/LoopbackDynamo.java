import java.lang.reflect.Field;

/** Development-only wrapper: DynamoDB Local's CLI otherwise binds every interface. */
class LoopbackDynamo {
  public static void main(String[] args) throws Exception {
    Class<?> runner = Class.forName("software.amazon.dynamodb.services.local.main.ServerRunner");
    Object proxy = runner.getMethod("createServerFromCommandLineArgs", String[].class)
      .invoke(null, (Object) args);
    Field field = proxy.getClass().getDeclaredField("server");
    field.setAccessible(true);
    Object server = field.get(proxy);
    Object[] connectors = (Object[]) server.getClass().getMethod("getConnectors").invoke(server);
    if (connectors.length == 0) throw new IllegalStateException("No local database connector");
    for (Object connector : connectors) connector.getClass().getMethod("setHost", String.class)
      .invoke(connector, "127.0.0.1");
    // Fail closed before start if a DynamoDB Local upgrade changes this binding API.
    proxy.getClass().getMethod("start").invoke(proxy);
    proxy.getClass().getMethod("join").invoke(proxy);
  }
}
