<?php
/**
 * Plugin Name: WPBridge ALPS Helper
 * Description: Exposes fixed, optimistic-lock protected ALPS presentation fields to WPBridge.
 * Version: 1.0.0
 */

if (!defined('ABSPATH')) {
    exit;
}

function wpbridge_alps_post_type($type) {
    return in_array($type, array('post', 'page'), true) ? $type : null;
}

function wpbridge_alps_layout_to_public($value) {
    $value = (string) $value;
    if ($value === '' || $value === 'false' || $value === 'none') {
        return 'none';
    }
    if ($value === 'header-block-featured' || $value === 'hero_50_50' || $value === 'true') {
        return 'hero_50_50';
    }
    if ($value === 'page-header' || $value === 'image_text_overlay') {
        return 'image_text_overlay';
    }
    return null;
}

function wpbridge_alps_layout_to_meta($value) {
    $map = array(
        'none' => 'false',
        'hero_50_50' => 'header-block-featured',
        'image_text_overlay' => 'page-header',
    );
    return isset($map[$value]) ? $map[$value] : null;
}

function wpbridge_alps_fields($post_id) {
    $layout = wpbridge_alps_layout_to_public(get_post_meta($post_id, '_featured_image_hero_layout', true));
    if ($layout === null) {
        $layout = 'none';
    }
    $hide = get_post_meta($post_id, '_hide_featured_image', true);
    return array(
        'large_banner' => $layout,
        'hide_featured_image' => in_array(strtolower((string) $hide), array('1', 'true', 'yes', 'on'), true),
    );
}

function wpbridge_alps_hash($fields) {
    // WPBridge canonicalizes object keys before hashing, so sort this flat map too.
    $canonical = $fields;
    ksort($canonical);
    return hash('sha256', wp_json_encode($canonical, JSON_UNESCAPED_SLASHES));
}

function wpbridge_alps_response($post_id) {
    $fields = wpbridge_alps_fields($post_id);
    return array(
        'post_id' => (int) $post_id,
        'fields' => $fields,
        'large_banner' => $fields['large_banner'],
        'hide_featured_image' => $fields['hide_featured_image'],
        'alps_sha256' => wpbridge_alps_hash($fields),
    );
}

function wpbridge_alps_error($code, $message, $status = 400) {
    return new WP_Error($code, $message, array('status' => $status));
}

add_action('rest_api_init', function () {
    register_rest_route('wpbridge/v1', '/alps/(?P<post_type>post|page)/(?P<id>\d+)', array(
        array(
            'methods' => WP_REST_Server::READABLE,
            'permission_callback' => function ($request) {
                $post_id = (int) $request['id'];
                return current_user_can('edit_post', $post_id);
            },
            'callback' => function ($request) {
                $post_id = (int) $request['id'];
                $type = wpbridge_alps_post_type((string) $request['post_type']);
                $post = get_post($post_id);
                if (!$type || !$post || $post->post_type !== $type) {
                    return wpbridge_alps_error('wpbridge_alps_not_found', 'Content item not found.', 404);
                }
                return rest_ensure_response(wpbridge_alps_response($post_id));
            },
        ),
        array(
            'methods' => WP_REST_Server::EDITABLE,
            'permission_callback' => function ($request) {
                $post_id = (int) $request['id'];
                return current_user_can('edit_post', $post_id);
            },
            'args' => array(
                'expected_alps_sha256' => array('required' => true, 'type' => 'string', 'minLength' => 64, 'maxLength' => 64),
                'large_banner' => array('required' => false, 'type' => 'string', 'enum' => array('none', 'hero_50_50', 'image_text_overlay')),
                'hide_featured_image' => array('required' => false, 'type' => 'boolean'),
            ),
            'callback' => function ($request) {
                $post_id = (int) $request['id'];
                $type = wpbridge_alps_post_type((string) $request['post_type']);
                $post = get_post($post_id);
                if (!$type || !$post || $post->post_type !== $type) {
                    return wpbridge_alps_error('wpbridge_alps_not_found', 'Content item not found.', 404);
                }
                $current = wpbridge_alps_response($post_id);
                $expected = strtolower((string) $request->get_param('expected_alps_sha256'));
                if (!preg_match('/^[a-f0-9]{64}$/', $expected) || !hash_equals(strtolower($current['alps_sha256']), $expected)) {
                    return new WP_Error('alps_edit_conflict', 'ALPS settings changed since they were read.', array('status' => 409, 'alps_sha256' => $current['alps_sha256'], 'fields' => $current['fields']));
                }
                $next = $current['fields'];
                if ($request->has_param('large_banner')) {
                    $next['large_banner'] = (string) $request->get_param('large_banner');
                }
                if ($request->has_param('hide_featured_image')) {
                    $next['hide_featured_image'] = (bool) $request->get_param('hide_featured_image');
                }
                $meta_layout = wpbridge_alps_layout_to_meta($next['large_banner']);
                if ($meta_layout === null) {
                    return wpbridge_alps_error('invalid_alps_large_banner', 'large_banner is not supported.');
                }
                update_post_meta($post_id, '_featured_image_hero_layout', $meta_layout);
                if ($next['hide_featured_image']) {
                    update_post_meta($post_id, '_hide_featured_image', 'true');
                } else {
                    update_post_meta($post_id, '_hide_featured_image', '');
                }
                return rest_ensure_response(wpbridge_alps_response($post_id));
            },
        ),
    ));
});
