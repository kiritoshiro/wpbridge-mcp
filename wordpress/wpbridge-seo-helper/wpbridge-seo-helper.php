<?php
/**
 * Plugin Name: WPBridge SEO Helper
 * Description: Restricted SEO metadata REST helper for the SiteOne WordPress ↔ ChatGPT bridge.
 * Version: 1.0.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Author: site-one.example
 * License: GPL-2.0-or-later
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class WPBridge_SEO_Helper {
	const REST_NAMESPACE = 'wpbridge/v1';
	const VERSION = '1.0.0';

	private static $field_limits = array(
		'title'          => 1000,
		'description'    => 3000,
		'focus_keyword'  => 1000,
		'canonical_url'  => 2048,
		'og_title'       => 1000,
		'og_description' => 3000,
	);

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	public static function register_routes() {
		register_rest_route(
			self::REST_NAMESPACE,
			'/seo/capabilities',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'capabilities' ),
				'permission_callback' => function() {
					return current_user_can( 'edit_posts' ) || current_user_can( 'edit_pages' );
				},
			)
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/seo/(?P<post_type>post|page)/(?P<id>\d+)',
			array(
				array(
					'methods'             => WP_REST_Server::READABLE,
					'callback'            => array( __CLASS__, 'get_seo' ),
					'permission_callback' => array( __CLASS__, 'can_edit_object' ),
					'args'                => self::route_args(),
				),
				array(
					'methods'             => WP_REST_Server::CREATABLE,
					'callback'            => array( __CLASS__, 'update_seo' ),
					'permission_callback' => array( __CLASS__, 'can_edit_object' ),
					'args'                => self::route_args(),
				),
			)
		);
	}

	private static function route_args() {
		return array(
			'post_type' => array(
				'required'          => true,
				'type'              => 'string',
				'enum'              => array( 'post', 'page' ),
				'sanitize_callback' => 'sanitize_key',
			),
			'id'        => array(
				'required'          => true,
				'type'              => 'integer',
				'minimum'           => 1,
				'sanitize_callback' => 'absint',
			),
		);
	}

	public static function can_edit_object( WP_REST_Request $request ) {
		$post = get_post( (int) $request['id'] );
		if ( ! $post || $post->post_type !== $request['post_type'] ) {
			return new WP_Error(
				'wpbridge_seo_object_not_found',
				'The requested post/page does not exist.',
				array( 'status' => 404 )
			);
		}
		return current_user_can( 'edit_post', $post->ID );
	}

	private static function detect_provider() {
		$yoast = defined( 'WPSEO_VERSION' ) || class_exists( 'WPSEO_Options' );
		$rank_math = defined( 'RANK_MATH_VERSION' ) || class_exists( '\RankMath\Helper' );

		if ( $yoast && $rank_math ) {
			return 'conflict';
		}
		if ( $yoast ) {
			return 'yoast';
		}
		if ( $rank_math ) {
			return 'rank_math';
		}
		return 'none';
	}

	private static function yoast_internal_key_map() {
		return array(
			'title'          => 'title',
			'description'    => 'metadesc',
			'focus_keyword'  => 'focuskw',
			'canonical_url'  => 'canonical',
			'og_title'       => 'opengraph-title',
			'og_description' => 'opengraph-description',
		);
	}

	private static function field_map( $provider ) {
		if ( 'yoast' === $provider ) {
			return array(
				'title'          => '_yoast_wpseo_title',
				'description'    => '_yoast_wpseo_metadesc',
				'focus_keyword'  => '_yoast_wpseo_focuskw',
				'canonical_url'  => '_yoast_wpseo_canonical',
				'og_title'       => '_yoast_wpseo_opengraph-title',
				'og_description' => '_yoast_wpseo_opengraph-description',
			);
		}
		if ( 'rank_math' === $provider ) {
			return array(
				'title'          => 'rank_math_title',
				'description'    => 'rank_math_description',
				'focus_keyword'  => 'rank_math_focus_keyword',
				'canonical_url'  => 'rank_math_canonical_url',
				'og_title'       => 'rank_math_facebook_title',
				'og_description' => 'rank_math_facebook_description',
			);
		}
		return array();
	}

	public static function capabilities() {
		$provider = self::detect_provider();
		$writable = array_keys( self::field_map( $provider ) );

		return rest_ensure_response(
			array(
				'available'       => in_array( $provider, array( 'yoast', 'rank_math' ), true ),
				'helper_installed'=> true,
				'helper_version'  => self::VERSION,
				'provider'        => $provider,
				'writable_fields' => $writable,
				'note'            => 'Only fixed SEO fields are exposed. Arbitrary post meta is not accessible.',
			)
		);
	}

	private static function current_fields( $post_id, $provider ) {
		$map = self::field_map( $provider );
		$fields = array();
		foreach ( $map as $public_name => $meta_key ) {
			$value = get_post_meta( $post_id, $meta_key, true );
			if ( is_array( $value ) || is_object( $value ) ) {
				$value = '';
			}
			$fields[ $public_name ] = (string) $value;
		}
		return $fields;
	}

	private static function seo_hash( $provider, $fields ) {
		$payload = array(
			'provider' => (string) $provider,
			'fields'   => $fields,
		);
		return hash( 'sha256', wp_json_encode( $payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) );
	}

	private static function response_for( $post, $provider ) {
		$fields = self::current_fields( $post->ID, $provider );

		return array(
			'id'         => (int) $post->ID,
			'post_type'  => (string) $post->post_type,
			'status'     => (string) $post->post_status,
			'provider'   => $provider,
			'available'  => in_array( $provider, array( 'yoast', 'rank_math' ), true ),
			'fields'     => $fields,
			'seo_sha256' => self::seo_hash( $provider, $fields ),
		);
	}

	public static function get_seo( WP_REST_Request $request ) {
		$post = get_post( (int) $request['id'] );
		$provider = self::detect_provider();

		if ( 'none' === $provider ) {
			return new WP_Error(
				'wpbridge_seo_not_available',
				'No supported SEO provider is active. Supported providers: Yoast SEO and Rank Math SEO.',
				array( 'status' => 409 )
			);
		}
		if ( 'conflict' === $provider ) {
			return new WP_Error(
				'wpbridge_seo_provider_conflict',
				'Yoast SEO and Rank Math SEO both appear active. Disable one before using SEO writes.',
				array( 'status' => 409 )
			);
		}

		return rest_ensure_response( self::response_for( $post, $provider ) );
	}

	private static function sanitize_field_value( $field, $value ) {
		if ( ! is_string( $value ) ) {
			return new WP_Error(
				'wpbridge_seo_invalid_field',
				sprintf( '%s must be a string.', $field ),
				array( 'status' => 400 )
			);
		}

		$limit = isset( self::$field_limits[ $field ] ) ? self::$field_limits[ $field ] : 0;
		if ( $limit && strlen( $value ) > $limit ) {
			return new WP_Error(
				'wpbridge_seo_field_too_long',
				sprintf( '%s is too long.', $field ),
				array( 'status' => 400 )
			);
		}

		if ( 'canonical_url' === $field ) {
			$value = trim( $value );
			if ( '' === $value ) {
				return '';
			}
			$parts = wp_parse_url( $value );
			if (
				! is_array( $parts ) ||
				empty( $parts['scheme'] ) ||
				! in_array( strtolower( $parts['scheme'] ), array( 'http', 'https' ), true ) ||
				empty( $parts['host'] )
			) {
				return new WP_Error(
					'wpbridge_seo_invalid_canonical',
					'canonical_url must be an absolute HTTP(S) URL or an empty string.',
					array( 'status' => 400 )
				);
			}
			return esc_url_raw( $value, array( 'http', 'https' ) );
		}

		if ( in_array( $field, array( 'description', 'og_description' ), true ) ) {
			return sanitize_textarea_field( $value );
		}

		return sanitize_text_field( $value );
	}

	public static function update_seo( WP_REST_Request $request ) {
		$post = get_post( (int) $request['id'] );
		$provider = self::detect_provider();

		if ( ! in_array( $provider, array( 'yoast', 'rank_math' ), true ) ) {
			return self::get_seo( $request );
		}

		$params = $request->get_json_params();
		if ( ! is_array( $params ) ) {
			$params = array();
		}

		$expected = isset( $params['expected_seo_sha256'] ) ? strtolower( (string) $params['expected_seo_sha256'] ) : '';
		if ( ! preg_match( '/^[a-f0-9]{64}$/', $expected ) ) {
			return new WP_Error(
				'wpbridge_seo_hash_required',
				'expected_seo_sha256 must be a 64-character SHA-256 hex digest.',
				array( 'status' => 400 )
			);
		}

		$current = self::response_for( $post, $provider );
		if ( ! hash_equals( $current['seo_sha256'], $expected ) ) {
			return new WP_Error(
				'wpbridge_seo_changed',
				'SEO metadata changed since it was read. Read it again before applying the edit.',
				array( 'status' => 409 )
			);
		}

		$incoming = isset( $params['fields'] ) && is_array( $params['fields'] ) ? $params['fields'] : array();
		$map = self::field_map( $provider );
		$updates = array();

		foreach ( $incoming as $field => $value ) {
			if ( ! array_key_exists( $field, $map ) ) {
				return new WP_Error(
					'wpbridge_seo_unknown_field',
					sprintf( 'Unsupported SEO field: %s.', sanitize_key( $field ) ),
					array( 'status' => 400 )
				);
			}
			$clean = self::sanitize_field_value( $field, $value );
			if ( is_wp_error( $clean ) ) {
				return $clean;
			}
			$updates[ $field ] = $clean;
		}

		if ( empty( $updates ) ) {
			return new WP_Error(
				'wpbridge_seo_no_fields',
				'At least one supported SEO field must be supplied.',
				array( 'status' => 400 )
			);
		}

		foreach ( $updates as $field => $value ) {
			$meta_key = $map[ $field ];

			// Prefer Yoast's own validated meta helper when it is available.
			if ( 'yoast' === $provider && class_exists( 'WPSEO_Meta' ) ) {
				$internal = self::yoast_internal_key_map();
				if ( '' === $value ) {
					WPSEO_Meta::delete( $internal[ $field ], $post->ID );
				} else {
					WPSEO_Meta::set_value( $internal[ $field ], $value, $post->ID );
				}
				continue;
			}

			if ( '' === $value ) {
				delete_post_meta( $post->ID, $meta_key );
			} else {
				update_post_meta( $post->ID, $meta_key, $value );
			}
		}

		clean_post_cache( $post->ID );
		return rest_ensure_response( self::response_for( get_post( $post->ID ), $provider ) );
	}
}

WPBridge_SEO_Helper::init();
