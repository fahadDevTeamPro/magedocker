<?php
return [
    'backend' => [
        'frontName' => 'opensesame'
    ],
    'crypt' => [
        'key' => 'invalidHWCGQg3NyDD9DdPCvwqDLBaBG
eb67a288cce2c98e5ef8de2e9871b62d'
    ],
    'db' => [
        'table_prefix' => '',
        'connection' => [
            'default' => [
                'host' => 'db',
                'dbname' => 'magento2',
                'username' => 'root',
                'password' => 'magento',
                'model' => 'mysql4',
                'engine' => 'innodb',
                'active' => '1',
                'driver_options' => [
                    1014 => false
                ]
            ]
        ]
    ],
    'resource' => [
        'default_setup' => [
            'connection' => 'default'
        ]
    ],
    'x-frame-options' => 'SAMEORIGIN',
    'MAGE_MODE' => 'developer',
    'session' => [
        'save' => 'redis',
        'redis' => [
            'host' => 'redis',
            'port' => '6379',
            'password' => '',
            'timeout' => '2.5',
            'persistent_identifier' => '',
            'database' => '2',
            'compression_threshold' => '2048',
            'compression_library' => 'gzip',
            'log_level' => '4',
            'max_concurrency' => '6',
            'break_after_frontend' => '5',
            'break_after_adminhtml' => '30',
            'first_lifetime' => '600',
            'bot_first_lifetime' => '60',
            'bot_lifetime' => '7200',
            'disable_locking' => '0',
            'min_lifetime' => '60',
            'max_lifetime' => '2592000',
            'sentinel_master' => '',
            'sentinel_servers' => '',
            'sentinel_connect_retries' => '5',
            'sentinel_verify_master' => '0'
        ]
    ],
    'lock' => [
        'provider' => 'db',
        'config' => [
            'prefix' => ''
        ]
    ],
    'cache_types' => [
        'config' => 1,
        'layout' => 1,
        'block_html' => 1,
        'collections' => 1,
        'reflection' => 1,
        'db_ddl' => 1,
        'compiled_config' => 1,
        'eav' => 1,
        'customer_notification' => 1,
        'config_integration' => 1,
        'config_integration_api' => 1,
        'google_product' => 1,
        'full_page' => 1,
        'config_webservice' => 1,
        'translate' => 1,
        'vertex' => 1,
        'target_rule' => 1,
        'amasty_shopby' => 1,
        'ec_cache' => 1,
        'pdp_breadcrumbs' => 1,
        'product_messages' => 1,
        'unbxd_facets' => 1,
        'webhooks_response' => 1,
        'graphql_query_resolver_result' => 1,
        'cache_import_product' => 1,
        'scripco_eav_attributes' => 0,
        'elasticsuite' => 1,
        'hyva_admin_dashboard' => 1
    ],
    'downloadable_domains' => [
        'magento2.test'
    ],
    'install' => [
        'date' => 'Fri, 10 Jan 2020 13:06:34 +0000'
    ],
    'system' => [
        'default' => [
            'dev' => [
                'debug' => [
                    'debug_logging' => '0'
                ]
            ],
            'catalog' => [
                'search' => [
                    'engine' => 'opensearch',
                    'opensearch_server_hostname' => 'opensearch',
                    'opensearch_server_port' => '9200',
                    'opensearch_index_prefix' => 'magento2',
                    'opensearch_enable_auth' => '0',
                    'opensearch_server_timeout' => '15'
                ]
            ]
        ]
    ],
    'db_logger' => [
        'output' => 'disabled',
        'log_everything' => 1,
        'query_time_threshold' => '0.001',
        'include_stacktrace' => 1
    ],
    'remote_storage' => [
        'driver' => 'file'
    ],
    'dev' => [
        'debug' => [
            'debug_logging' => 0
        ]
    ],
    'config' => [
        'async' => 0
    ],
    'checkout' => [
        'async' => 0,
        'deferred_total_calculating' => 0
    ],
    'queue' => [
        'consumers_wait_for_messages' => 1
    ],
    'directories' => [
        'document_root_is_pub' => true
    ],
    'cron' => [
        'enabled' => 0
    ],
    'cache' => [
        'graphql' => [
            'id_salt' => 'R0zj1hcJ3zLrSwR9q57eA5pUgBpuslSp'
        ]
    ]
];
