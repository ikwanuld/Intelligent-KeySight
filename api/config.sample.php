<?php
// Copy this file to config.php and fill it in. config.php must never be public
// in a repository: it holds the database password.
return [
    'db' => [
        'host' => 'localhost',
        'name' => 'uld_scanner',
        'user' => 'CHANGE_ME',
        'pass' => 'CHANGE_ME',
    ],

    // Web addresses allowed to call this API (where the scanner page lives).
    // No trailing slash, no path. Example: 'https://yourname.github.io'
    'allowed_origins' => ['https://CHANGE_ME.github.io'],

    // Only e-mail addresses on these domains may sign in. Empty = any domain.
    'company_domains' => [],

    // These addresses become Admin automatically the first time they sign in,
    // with access to every station. Everyone else must be added to `users`.
    'bootstrap_admins' => ['you@company.com'],

    // How long a sign-in lasts on a device.
    'token_days' => 30,

    // Secret for cron.php when it is called by URL (?key=...). Change it.
    'cron_key' => 'CHANGE_ME_TO_A_LONG_RANDOM_STRING',
];
