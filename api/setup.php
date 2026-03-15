<?php
/**
 * EasyDraft setup — run once to initialise the database.
 * Access via browser: http://your-server/easydraft/api/setup.php
 * DELETE or restrict this file after setup is complete.
 */

$error   = '';
$success = '';
$step    = isset($_POST['step']) ? (int)$_POST['step'] : 0;

if ($step === 1 && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $host     = trim($_POST['db_host']     ?? 'localhost');
    $name     = trim($_POST['db_name']     ?? 'easydraft');
    $user     = trim($_POST['db_user']     ?? '');
    $pass     = trim($_POST['db_pass']     ?? '');
    $league   = trim($_POST['league_name'] ?? 'My League');
    $adminPin = trim($_POST['admin_pin']   ?? '');

    if (!$user || !$adminPin) {
        $error = 'DB username and admin PIN are required.';
    } else {
        try {
            // Connect without DB name first to create it
            $pdo = new PDO(
                "mysql:host=$host;charset=utf8mb4",
                $user, $pass,
                [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
            );

            // Create database
            $pdo->exec("CREATE DATABASE IF NOT EXISTS `$name` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
            $pdo->exec("USE `$name`");

            // Run schema
            $schema = file_get_contents(__DIR__ . '/../sql/schema.sql');
            // Strip the CREATE DATABASE / USE lines — already handled above
            $schema = preg_replace('/^CREATE DATABASE.*?;\n/im', '', $schema);
            $schema = preg_replace('/^USE.*?;\n/im', '', $schema);

            foreach (array_filter(array_map('trim', explode(';', $schema))) as $stmt) {
                if ($stmt !== '') $pdo->exec($stmt);
            }

            // Write config.php
            $config = "<?php\ndefine('DB_HOST', " . var_export($host, true) . ");\n"
                    . "define('DB_NAME', " . var_export($name, true) . ");\n"
                    . "define('DB_USER', " . var_export($user, true) . ");\n"
                    . "define('DB_PASS', " . var_export($pass, true) . ");\n";
            file_put_contents(__DIR__ . '/config.php', $config);

            // Save settings
            $stmt = $pdo->prepare("INSERT INTO settings (`key`, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)");
            $stmt->execute(['league_name', $league]);
            $stmt->execute(['admin_pin',   $adminPin]);

            $success = "Setup complete! <strong>Delete or restrict access to setup.php.</strong>";
        } catch (Exception $e) {
            $error = 'Setup failed: ' . htmlspecialchars($e->getMessage());
        }
    }
}
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>EasyDraft Setup</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #f0f2f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
  .card { background: #fff; border-radius: 10px; box-shadow: 0 4px 24px rgba(0,0,0,.1); padding: 36px 40px; width: 100%; max-width: 480px; }
  h1 { font-size: 22px; font-weight: 800; color: #1e3a5f; margin-bottom: 6px; }
  p.sub { font-size: 13px; color: #666; margin-bottom: 28px; }
  label { display: block; font-size: 12px; font-weight: 700; color: #444; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px; margin-top: 14px; }
  input { width: 100%; padding: 9px 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; }
  input:focus { outline: none; border-color: #1a56db; }
  .sep { margin: 20px 0 6px; font-size: 11px; font-weight: 700; color: #999; text-transform: uppercase; letter-spacing: 1px; border-top: 1px solid #eee; padding-top: 16px; }
  button { width: 100%; margin-top: 24px; padding: 12px; background: #1e3a5f; color: #fff; border: none; border-radius: 6px; font-size: 15px; font-weight: 700; cursor: pointer; }
  button:hover { background: #162d4a; }
  .error   { background: #fee2e2; color: #991b1b; padding: 10px 14px; border-radius: 6px; font-size: 13px; margin-bottom: 16px; }
  .success { background: #dcfce7; color: #166534; padding: 10px 14px; border-radius: 6px; font-size: 13px; margin-bottom: 16px; }
</style>
</head>
<body>
<div class="card">
  <h1>⚾ EasyDraft Setup</h1>
  <p class="sub">Configure your database and league settings to get started.</p>

  <?php if ($error):   ?><div class="error"><?= $error ?></div><?php endif; ?>
  <?php if ($success): ?><div class="success"><?= $success ?></div><?php endif; ?>

  <?php if (!$success): ?>
  <form method="POST">
    <input type="hidden" name="step" value="1">

    <div class="sep">Database</div>
    <label>Host</label>
    <input name="db_host" value="<?= htmlspecialchars($_POST['db_host'] ?? 'localhost') ?>" placeholder="localhost">
    <label>Database Name</label>
    <input name="db_name" value="<?= htmlspecialchars($_POST['db_name'] ?? 'easydraft') ?>" placeholder="easydraft">
    <label>DB Username</label>
    <input name="db_user" value="<?= htmlspecialchars($_POST['db_user'] ?? '') ?>" placeholder="root">
    <label>DB Password</label>
    <input type="password" name="db_pass" placeholder="(leave blank if none)">

    <div class="sep">League</div>
    <label>League Name</label>
    <input name="league_name" value="<?= htmlspecialchars($_POST['league_name'] ?? 'My League') ?>" placeholder="Springfield Little League">
    <label>Admin PIN <small style="font-weight:400;text-transform:none">(full control)</small></label>
    <input type="password" name="admin_pin" placeholder="Choose a secure PIN">
    <p style="margin-top:10px;font-size:12px;color:#666">Coach PINs are set per-draft inside the app after setup.</p>

    <button type="submit">Run Setup</button>
  </form>
  <?php endif; ?>
</div>
</body>
</html>
