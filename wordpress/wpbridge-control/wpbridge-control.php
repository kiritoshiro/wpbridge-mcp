<?php
/**
 * Plugin Name: WPBridge Control
 * Description: Small, capability-gated WordPress site settings and plugin maintenance API for WPBridge.
 * Version: 0.1.0
 * Requires at least: 6.0
 */

if (!defined('ABSPATH')) {
    exit;
}

function wpbridge_control_error($code, $message, $status = 400) {
    return new WP_Error($code, $message, array('status' => $status));
}

function wpbridge_control_settings() {
    $settings = array();
    foreach (array('blogname', 'blogdescription', 'timezone_string', 'posts_per_page') as $key) {
        $settings[$key] = get_option($key);
    }
    return $settings;
}

function wpbridge_control_site() {
    $settings = wpbridge_control_settings();
    return array(
        'site_url' => get_site_url(),
        'settings' => $settings,
        'fingerprint' => hash('sha256', wp_json_encode($settings)),
    );
}

function wpbridge_control_plugins() {
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    $plugins = get_plugins();
    $updates = get_site_transient('update_plugins');
    $result = array();
    foreach ($plugins as $file => $plugin) {
        $offer = isset($updates->response[$file]) ? $updates->response[$file] : null;
        $result[] = array(
            'plugin' => $file,
            'name' => $plugin['Name'],
            'version' => $plugin['Version'],
            'active' => is_plugin_active($file),
            'update_version' => $offer ? (string) $offer->new_version : null,
        );
    }
    return array('plugins' => $result);
}

add_action('rest_api_init', function () {
    register_rest_route('wpbridge-control/v1', '/site', array(
        array(
            'methods' => WP_REST_Server::READABLE,
            'permission_callback' => function () { return current_user_can('manage_options'); },
            'callback' => function () { return rest_ensure_response(wpbridge_control_site()); },
        ),
        array(
            'methods' => WP_REST_Server::CREATABLE,
            'permission_callback' => function () { return current_user_can('manage_options'); },
            'callback' => function ($request) {
                if ($request->get_param('confirm') !== 'UPDATE_SITE_SETTINGS') {
                    return wpbridge_control_error('confirmation_required', 'Explicit site-settings confirmation is required.', 409);
                }
                $current = wpbridge_control_site();
                $expected = (string) $request->get_param('expected_fingerprint');
                if (!preg_match('/^[a-f0-9]{64}$/', $expected) || !hash_equals($current['fingerprint'], $expected)) {
                    return wpbridge_control_error('settings_changed', 'Site settings changed; read and review them again.', 409);
                }
                $changes = $request->get_param('changes');
                if (!is_array($changes) || !$changes || array_diff(array_keys($changes), array_keys($current['settings']))) {
                    return wpbridge_control_error('invalid_changes', 'Only supported site settings may be changed.');
                }
                foreach ($changes as $key => $value) {
                    if ($key === 'posts_per_page') {
                        if (!is_numeric($value) || (int) $value < 1 || (int) $value > 100 || (string) (int) $value !== (string) $value) {
                            return wpbridge_control_error('invalid_posts_per_page', 'posts_per_page must be an integer from 1 to 100.');
                        }
                        $changes[$key] = (int) $value;
                    } elseif ($key === 'timezone_string') {
                        if (!is_string($value) || !in_array($value, timezone_identifiers_list(), true)) {
                            return wpbridge_control_error('invalid_timezone', 'Use a recognized timezone name.');
                        }
                    } else {
                        if (!is_string($value) || strlen($value) > 800) {
                            return wpbridge_control_error('invalid_text', 'Site title and tagline must be text of at most 800 UTF-8 bytes.');
                        }
                        $changes[$key] = sanitize_text_field($value);
                    }
                }
                foreach ($changes as $key => $value) {
                    update_option($key, $value);
                }
                return rest_ensure_response(wpbridge_control_site());
            },
        ),
    ));

    register_rest_route('wpbridge-control/v1', '/plugins', array(
        'methods' => WP_REST_Server::READABLE,
        'permission_callback' => function () { return current_user_can('activate_plugins'); },
        'callback' => function () { return rest_ensure_response(wpbridge_control_plugins()); },
    ));

    register_rest_route('wpbridge-control/v1', '/plugins/update', array(
        'methods' => WP_REST_Server::CREATABLE,
        'permission_callback' => function () { return current_user_can('update_plugins'); },
        'callback' => function ($request) {
            if ($request->get_param('confirm') !== 'UPDATE_PLUGIN') {
                return wpbridge_control_error('confirmation_required', 'Explicit plugin-update confirmation is required.', 409);
            }
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
            require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
            $file = (string) $request->get_param('plugin');
            $installed = get_plugins();
            if (!array_key_exists($file, $installed)) {
                return wpbridge_control_error('plugin_not_found', 'Installed plugin was not found.', 404);
            }
            if ((string) $request->get_param('expected_version') !== (string) $installed[$file]['Version']) {
                return wpbridge_control_error('plugin_changed', 'Plugin version changed; read and review it again.', 409);
            }
            wp_update_plugins();
            $updates = get_site_transient('update_plugins');
            if (!isset($updates->response[$file])) {
                return wpbridge_control_error('no_update', 'No update is currently available for this plugin.', 409);
            }
            $upgrader = new Plugin_Upgrader(new Automatic_Upgrader_Skin());
            $updated = $upgrader->upgrade($file);
            if (is_wp_error($updated)) {
                return wpbridge_control_error('plugin_update_failed', $updated->get_error_message(), 502);
            }
            if (!$updated) {
                return wpbridge_control_error('plugin_update_failed', 'WordPress did not complete the plugin update.', 502);
            }
            wp_clean_plugins_cache(true);
            $now = get_plugins();
            return rest_ensure_response(array(
                'plugin' => $file,
                'previous_version' => $installed[$file]['Version'],
                'version' => isset($now[$file]) ? $now[$file]['Version'] : null,
                'updated' => true,
            ));
        },
    ));
});
