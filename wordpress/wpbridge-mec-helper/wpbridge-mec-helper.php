<?php
/**
 * Plugin Name: WPBridge MEC Calendar Helper
 * Description: Exposes fixed, optimistic-lock protected Modern Events Calendar editorial fields to WPBridge.
 * Version: 1.0.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Author: site-one.example
 * License: GPL-2.0-or-later
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class WPBridge_MEC_Helper {
	const REST_NAMESPACE = 'wpbridge/v1';
	const VERSION = '1.0.0';
	const POST_TYPE = 'mec-events';

	private static $taxonomies = array(
		'categories' => 'mec_category',
		'locations'  => 'mec_location',
		'organizers' => 'mec_organizer',
		'labels'     => 'mec_label',
		'speakers'   => 'mec_speaker',
		'sponsors'   => 'mec_sponsor',
		'tags'       => 'mec_tag',
	);

	private static $repeat_types = array(
		'daily', 'weekday', 'weekend', 'certain_weekdays', 'weekly',
		'monthly', 'yearly', 'custom_days', 'advanced',
	);

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	public static function register_routes() {
		register_rest_route(
			self::REST_NAMESPACE,
			'/calendar/capabilities',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'capabilities' ),
				'permission_callback' => array( __CLASS__, 'can_manage' ),
			)
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/calendar/events',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'list_events' ),
				'permission_callback' => array( __CLASS__, 'can_manage' ),
			)
		);
		register_rest_route(
			self::REST_NAMESPACE,
			'/calendar/events',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'create_event' ),
				'permission_callback' => array( __CLASS__, 'can_manage' ),
			)
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/calendar/events/(?P<id>\d+)',
			array(
				array(
					'methods'             => WP_REST_Server::READABLE,
					'callback'            => array( __CLASS__, 'get_event' ),
					'permission_callback' => array( __CLASS__, 'can_edit_event' ),
				),
				array(
					'methods'             => WP_REST_Server::CREATABLE,
					'callback'            => array( __CLASS__, 'update_event' ),
					'permission_callback' => array( __CLASS__, 'can_edit_event' ),
				),
			)
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/calendar/taxonomies/(?P<taxonomy>[a-z0-9_-]+)/terms',
			array(
				array(
					'methods'             => WP_REST_Server::READABLE,
					'callback'            => array( __CLASS__, 'list_terms' ),
					'permission_callback' => array( __CLASS__, 'can_manage' ),
				),
				array(
					'methods'             => WP_REST_Server::CREATABLE,
					'callback'            => array( __CLASS__, 'create_term' ),
					'permission_callback' => array( __CLASS__, 'can_manage' ),
				),
			)
		);
	}

	public static function can_manage() {
		if ( ! self::available() ) {
			return self::error( 'mec_not_available', 'Modern Events Calendar is not active.', 503 );
		}
		return current_user_can( 'edit_posts' );
	}

	public static function can_edit_event( WP_REST_Request $request ) {
		if ( ! self::available() ) {
			return self::error( 'mec_not_available', 'Modern Events Calendar is not active.', 503 );
		}
		$post = get_post( (int) $request['id'] );
		if ( ! $post || self::POST_TYPE !== $post->post_type ) {
			return self::error( 'mec_event_not_found', 'The requested calendar event does not exist.', 404 );
		}
		return current_user_can( 'edit_post', $post->ID );
	}

	private static function available() {
		return class_exists( 'MEC' ) && method_exists( 'MEC', 'getInstance' ) && post_type_exists( self::POST_TYPE );
	}

	private static function main() {
		return MEC::getInstance( 'app.libraries.main' );
	}

	private static function error( $code, $message, $status = 400, $data = array() ) {
		return new WP_Error( $code, $message, array_merge( array( 'status' => (int) $status ), $data ) );
	}

	private static function json_params( WP_REST_Request $request ) {
		$params = $request->get_json_params();
		return is_array( $params ) ? $params : array();
	}

	private static function clean_text( $value, $max = 1000 ) {
		if ( ! is_scalar( $value ) ) return '';
		return mb_substr( sanitize_text_field( (string) $value ), 0, $max );
	}

	private static function clean_date( $value, $field ) {
		$value = self::clean_text( $value, 10 );
		$parsed = DateTime::createFromFormat( '!Y-m-d', $value );
		$errors = DateTime::getLastErrors();
		if ( ! preg_match( '/^\d{4}-\d{2}-\d{2}$/', $value ) || ! $parsed || ( is_array( $errors ) && ( $errors['warning_count'] || $errors['error_count'] ) ) || $parsed->format( 'Y-m-d' ) !== $value ) {
			return self::error( 'invalid_calendar_date', $field . ' must use YYYY-MM-DD.', 400 );
		}
		return $value;
	}

	private static function time_parts( $value, $field, $fallback_hour, $fallback_minutes, $fallback_ampm ) {
		if ( $value === null || $value === '' ) {
			return array( (int) $fallback_hour, (int) $fallback_minutes, strtoupper( (string) $fallback_ampm ) === 'PM' ? 'PM' : 'AM' );
		}
		$value = self::clean_text( $value, 8 );
		if ( ! preg_match( '/^(\d{1,2}):(\d{2})(?:\s*([AP]M))?$/i', $value, $match ) ) {
			return self::error( 'invalid_calendar_time', $field . ' must use HH:MM or HH:MM AM/PM.', 400 );
		}
		$hour = (int) $match[1];
		$minutes = (int) $match[2];
		$ampm = isset( $match[3] ) && $match[3] !== '' ? strtoupper( $match[3] ) : ( $hour >= 12 ? 'PM' : 'AM' );
		if ( $hour > 23 || $minutes > 59 ) return self::error( 'invalid_calendar_time', $field . ' is outside the valid time range.', 400 );
		if ( ! isset( $match[3] ) || $match[3] === '' ) {
			if ( $hour === 0 ) $hour = 12;
			elseif ( $hour > 12 ) $hour -= 12;
		}
		if ( $hour < 1 || $hour > 12 ) return self::error( 'invalid_calendar_time', $field . ' must use a 1–12 hour when AM/PM is supplied.', 400 );
		return array( $hour, $minutes, $ampm );
	}

	private static function term( $id, $taxonomy ) {
		if ( ! $id ) return null;
		$term = get_term( (int) $id, $taxonomy );
		return ( $term && ! is_wp_error( $term ) ) ? $term : null;
	}

	private static function term_summary( $term, $taxonomy ) {
		if ( ! $term || is_wp_error( $term ) ) return null;
		$summary = array(
			'id'         => (int) $term->term_id,
			'name'       => (string) $term->name,
			'slug'       => (string) $term->slug,
			'description'=> (string) $term->description,
			'taxonomy'   => (string) $taxonomy,
			'count'      => (int) $term->count,
		);
		$meta_keys = array(
			'mec_location' => array( 'address', 'latitude', 'longitude', 'tel', 'email', 'url', 'thumbnail', 'opening_hour' ),
			'mec_organizer' => array( 'email', 'tel', 'url', 'thumbnail' ),
			'mec_speaker' => array( 'type', 'job_title', 'tel', 'email', 'website', 'thumbnail' ),
		);
		foreach ( $meta_keys[ $taxonomy ] ?? array() as $key ) {
			$value = get_term_meta( $term->term_id, $key, true );
			if ( is_scalar( $value ) && $value !== '' ) $summary[ $key ] = (string) $value;
		}
		return $summary;
	}

	private static function terms_for( $post_id, $taxonomy ) {
		if ( ! taxonomy_exists( $taxonomy ) ) return array();
		$terms = wp_get_post_terms( $post_id, $taxonomy );
		if ( is_wp_error( $terms ) || ! is_array( $terms ) ) return array();
		return array_values( array_filter( array_map( function ( $term ) use ( $taxonomy ) {
			return self::term_summary( $term, $taxonomy );
		}, $terms ) ) );
	}

	private static function meta_scalar( $post_id, $key, $fallback = '' ) {
		$value = get_post_meta( $post_id, $key, true );
		return ( is_scalar( $value ) || $value === null ) ? (string) $value : $fallback;
	}

	private static function numeric_ids( $value, $field, $max = 100 ) {
		if ( ! is_array( $value ) || count( $value ) > $max ) return self::error( 'invalid_calendar_ids', $field . ' must be an array of at most ' . $max . ' IDs.', 400 );
		$out = array();
		foreach ( $value as $item ) {
			if ( ! is_numeric( $item ) || (int) $item < 1 ) return self::error( 'invalid_calendar_ids', $field . ' contains an invalid ID.', 400 );
			$out[] = (int) $item;
		}
		return array_values( array_unique( $out ) );
	}

	private static function event_data( $post_id ) {
		$post = get_post( (int) $post_id );
		if ( ! $post || self::POST_TYPE !== $post->post_type ) return null;
		$start_hour = (int) self::meta_scalar( $post_id, 'mec_start_time_hour', '8' );
		$start_minutes = (int) self::meta_scalar( $post_id, 'mec_start_time_minutes', '0' );
		$start_ampm = strtoupper( self::meta_scalar( $post_id, 'mec_start_time_ampm', 'AM' ) );
		$end_hour = (int) self::meta_scalar( $post_id, 'mec_end_time_hour', '6' );
		$end_minutes = (int) self::meta_scalar( $post_id, 'mec_end_time_minutes', '0' );
		$end_ampm = strtoupper( self::meta_scalar( $post_id, 'mec_end_time_ampm', 'PM' ) );
		$repeat_status = (int) self::meta_scalar( $post_id, 'mec_repeat_status', '0' );
		$repeat_end = self::meta_scalar( $post_id, 'mec_repeat_end', 'never' );
		$event = array(
			'id'            => (int) $post->ID,
			'post_type'     => self::POST_TYPE,
			'status'        => (string) $post->post_status,
			'title'         => (string) $post->post_title,
			'content'       => (string) $post->post_content,
			'excerpt'       => (string) $post->post_excerpt,
			'slug'          => (string) $post->post_name,
			'author_id'     => (int) $post->post_author,
			'link'          => (string) get_permalink( $post->ID ),
			'modified_gmt'  => (string) get_post_modified_time( 'c', true, $post ),
			'featured_media'=> (int) get_post_thumbnail_id( $post->ID ),
			'start_date'    => self::meta_scalar( $post_id, 'mec_start_date' ),
			'start_time'    => sprintf( '%02d:%02d %s', $start_hour, $start_minutes, $start_ampm === 'PM' ? 'PM' : 'AM' ),
			'end_date'      => self::meta_scalar( $post_id, 'mec_end_date' ),
			'end_time'      => sprintf( '%02d:%02d %s', $end_hour, $end_minutes, $end_ampm === 'PM' ? 'PM' : 'AM' ),
			'all_day'       => '1' === self::meta_scalar( $post_id, 'mec_allday', '0' ),
			'hide_time'     => '1' === self::meta_scalar( $post_id, 'mec_hide_time', '0' ),
			'hide_end_time' => '1' === self::meta_scalar( $post_id, 'mec_hide_end_time', '0' ),
			'time_comment'  => self::meta_scalar( $post_id, 'mec_comment' ),
			'timezone'      => self::meta_scalar( $post_id, 'mec_timezone', 'global' ),
			'repeat'        => array(
				'enabled'       => (bool) $repeat_status,
				'type'          => self::meta_scalar( $post_id, 'mec_repeat_type' ),
				'interval'      => (int) self::meta_scalar( $post_id, 'mec_repeat_interval', '1' ),
				'end'           => $repeat_end ?: 'never',
				'end_date'      => self::meta_scalar( $post_id, 'mec_repeat_end_at_date' ),
				'occurrences'   => (int) self::meta_scalar( $post_id, 'mec_repeat_end_at_occurrences', '0' ),
				'weekdays'      => get_post_meta( $post_id, 'mec_certain_weekdays', true ),
				'advanced_days' => get_post_meta( $post_id, 'mec_advanced_days', true ),
				'in_days'       => get_post_meta( $post_id, 'mec_in_days', true ),
				'not_in_days'   => get_post_meta( $post_id, 'mec_not_in_days', true ),
			),
			'more_info'      => self::meta_scalar( $post_id, 'mec_more_info' ),
			'more_info_title'=> self::meta_scalar( $post_id, 'mec_more_info_title' ),
			'more_info_target'=> self::meta_scalar( $post_id, 'mec_more_info_target', '_self' ),
			'read_more'      => self::meta_scalar( $post_id, 'mec_read_more' ),
			'cost'           => self::meta_scalar( $post_id, 'mec_cost' ),
			'color'          => self::meta_scalar( $post_id, 'mec_color' ),
			'gallery_media_ids' => array_values( array_filter( array_map( 'intval', (array) get_post_meta( $post_id, 'mec_event_gallery', true ) ) ) ),
			'additional_location_ids' => array_values( array_filter( array_map( 'intval', (array) get_post_meta( $post_id, 'mec_additional_location_ids', true ) ) ) ),
			'additional_organizer_ids' => array_values( array_filter( array_map( 'intval', (array) get_post_meta( $post_id, 'mec_additional_organizer_ids', true ) ) ) ),
			'taxonomies' => array(),
		);
		foreach ( self::$taxonomies as $name => $taxonomy ) {
			if ( taxonomy_exists( $taxonomy ) ) {
				$event['taxonomies'][ $name ] = self::terms_for( $post_id, $taxonomy );
				$id_key = array( 'categories' => 'category_ids', 'locations' => 'location_ids', 'organizers' => 'organizer_ids', 'labels' => 'label_ids', 'speakers' => 'speaker_ids', 'sponsors' => 'sponsor_ids', 'tags' => 'tag_ids' )[ $name ] ?? '';
				if ( $id_key ) $event[ $id_key ] = array_values( array_map( function ( $term ) { return (int) $term['id']; }, $event['taxonomies'][ $name ] ) );
			}
		}
		$event['location_id'] = ! empty( $event['taxonomies']['locations'][0]['id'] ) ? (int) $event['taxonomies']['locations'][0]['id'] : (int) self::meta_scalar( $post_id, 'mec_location_id', '0' );
		$event['organizer_id'] = ! empty( $event['taxonomies']['organizers'][0]['id'] ) ? (int) $event['taxonomies']['organizers'][0]['id'] : (int) self::meta_scalar( $post_id, 'mec_organizer_id', '0' );
		return $event;
	}

	private static function response( $event ) {
		$hash = hash( 'sha256', wp_json_encode( $event, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) );
		return array( 'event' => $event, 'calendar_sha256' => $hash );
	}

	public static function capabilities() {
		return rest_ensure_response( array(
			'available'       => self::available(),
			'helper_installed'=> true,
			'helper_version'  => self::VERSION,
			'post_type'       => self::POST_TYPE,
			'repeat_types'    => self::$repeat_types,
			'taxonomies'      => array_keys( self::$taxonomies ),
			'writable_fields' => array( 'author_id', 'title', 'content', 'excerpt', 'status', 'start_date', 'start_time', 'end_date', 'end_time', 'all_day', 'hide_time', 'hide_end_time', 'time_comment', 'timezone', 'repeat', 'location_id', 'organizer_id', 'additional_location_ids', 'additional_organizer_ids', 'category_ids', 'label_ids', 'tag_ids', 'speaker_ids', 'sponsor_ids', 'featured_media', 'gallery_media_ids', 'more_info', 'more_info_title', 'more_info_target', 'read_more', 'cost', 'color' ),
			'excluded_fields' => array( 'bookings', 'tickets', 'fees', 'attendees', 'payments', 'notifications' ),
			'note'            => 'Only fixed editorial event fields are exposed. Booking, payment and attendee data are intentionally excluded.',
		) );
	}

	public static function list_events( WP_REST_Request $request ) {
		$per_page = max( 1, min( 50, (int) ( $request->get_param( 'per_page' ) ?: 20 ) ) );
		$page = max( 1, min( 10000, (int) ( $request->get_param( 'page' ) ?: 1 ) ) );
		$status = self::clean_text( $request->get_param( 'status' ) ?: 'publish', 20 );
		$allowed = array( 'publish', 'draft', 'pending', 'future', 'private', 'all' );
		if ( ! in_array( $status, $allowed, true ) ) return self::error( 'invalid_calendar_status', 'Unsupported calendar status.', 400 );
		$args = array(
			'post_type'      => self::POST_TYPE,
			'post_status'    => 'all' === $status ? array( 'publish', 'draft', 'pending', 'future', 'private' ) : $status,
			'posts_per_page' => $per_page,
			'paged'          => $page,
			'orderby'        => in_array( $request->get_param( 'orderby' ), array( 'date', 'modified', 'title', 'ID' ), true ) ? $request->get_param( 'orderby' ) : 'modified',
			'order'          => strtoupper( $request->get_param( 'order' ) ) === 'ASC' ? 'ASC' : 'DESC',
			's'              => self::clean_text( $request->get_param( 'search' ), 200 ),
		);
		$meta_query = array();
		foreach ( array( 'start_after' => '>=', 'start_before' => '<=' ) as $param => $compare ) {
			if ( $request->get_param( $param ) !== null && $request->get_param( $param ) !== '' ) {
				$date = self::clean_date( $request->get_param( $param ), $param );
				if ( is_wp_error( $date ) ) return $date;
				$meta_query[] = array( 'key' => 'mec_start_date', 'value' => $date, 'compare' => $compare, 'type' => 'DATE' );
			}
		}
		$tax_query = array();
		foreach ( array( 'category_id' => 'mec_category', 'location_id' => 'mec_location', 'organizer_id' => 'mec_organizer' ) as $param => $taxonomy ) {
			if ( $request->get_param( $param ) !== null && $request->get_param( $param ) !== '' ) {
				if ( ! is_numeric( $request->get_param( $param ) ) ) return self::error( 'invalid_calendar_filter', $param . ' must be numeric.', 400 );
				$tax_query[] = array( 'taxonomy' => $taxonomy, 'field' => 'term_id', 'terms' => (int) $request->get_param( $param ) );
			}
		}
		if ( count( $meta_query ) ) $args['meta_query'] = $meta_query;
		if ( count( $tax_query ) ) $args['tax_query'] = $tax_query;
		$query = new WP_Query( $args );
		$items = array();
		foreach ( $query->posts as $post ) {
			$data = self::event_data( $post->ID );
			if ( $data ) $items[] = self::response( $data );
		}
		return rest_ensure_response( array(
			'post_type' => self::POST_TYPE,
			'items' => $items,
			'page' => $page,
			'per_page' => $per_page,
			'total' => (int) $query->found_posts,
			'total_pages' => (int) $query->max_num_pages,
		) );
	}

	public static function get_event( WP_REST_Request $request ) {
		$data = self::event_data( (int) $request['id'] );
		if ( ! $data ) return self::error( 'mec_event_not_found', 'The requested calendar event does not exist.', 404 );
		return rest_ensure_response( self::response( $data ) );
	}

	private static function list_value( $params, $key, $current, $max = 100 ) {
		if ( ! array_key_exists( $key, $params ) ) return $current;
		$ids = self::numeric_ids( $params[ $key ], $key, $max );
		return is_wp_error( $ids ) ? $ids : $ids;
	}

	private static function payload_args( $params, $current = null, $creating = false ) {
		$old = is_array( $current ) ? $current : array();
		$title = array_key_exists( 'title', $params ) ? self::clean_text( $params['title'], 500 ) : ( $old['title'] ?? '' );
		if ( '' === $title ) return self::error( 'calendar_title_required', 'title is required.', 400 );
		$content = array_key_exists( 'content', $params ) ? wp_kses_post( (string) $params['content'] ) : ( $old['content'] ?? '' );
		$status = array_key_exists( 'status', $params ) ? self::clean_text( $params['status'], 20 ) : ( $old['status'] ?? 'draft' );
		if ( ! in_array( $status, array( 'draft', 'pending', 'publish', 'future', 'private' ), true ) ) return self::error( 'invalid_calendar_status', 'status is not supported.', 400 );
		$start_date = array_key_exists( 'start_date', $params ) ? self::clean_date( $params['start_date'], 'start_date' ) : ( $old['start_date'] ?? gmdate( 'Y-m-d' ) );
		if ( is_wp_error( $start_date ) ) return $start_date;
		$end_date = array_key_exists( 'end_date', $params ) ? self::clean_date( $params['end_date'], 'end_date' ) : ( $old['end_date'] ?? $start_date );
		if ( is_wp_error( $end_date ) ) return $end_date;
		$start_time = self::time_parts( array_key_exists( 'start_time', $params ) ? $params['start_time'] : ( $old['start_time'] ?? null ), 'start_time', 8, 0, 'AM' );
		$end_time = self::time_parts( array_key_exists( 'end_time', $params ) ? $params['end_time'] : ( $old['end_time'] ?? null ), 'end_time', 6, 0, 'PM' );
		if ( is_wp_error( $start_time ) ) return $start_time;
		if ( is_wp_error( $end_time ) ) return $end_time;
		$repeat = isset( $params['repeat'] ) ? $params['repeat'] : ( $old['repeat'] ?? array() );
		if ( ! is_array( $repeat ) ) return self::error( 'invalid_calendar_repeat', 'repeat must be an object.', 400 );
		$repeat_enabled = ! empty( $repeat['enabled'] );
		$repeat_type = self::clean_text( $repeat['type'] ?? '', 30 );
		if ( $repeat_enabled && ! in_array( $repeat_type, self::$repeat_types, true ) ) return self::error( 'invalid_calendar_repeat', 'repeat.type is not supported.', 400 );
		$interval = isset( $repeat['interval'] ) ? (int) $repeat['interval'] : 1;
		if ( $interval < 1 || $interval > 365 ) return self::error( 'invalid_calendar_repeat', 'repeat.interval must be between 1 and 365.', 400 );
		$repeat_end = self::clean_text( $repeat['end'] ?? 'never', 20 ) ?: 'never';
		if ( ! in_array( $repeat_end, array( 'never', 'date', 'occurrences' ), true ) ) return self::error( 'invalid_calendar_repeat', 'repeat.end must be never, date, or occurrences.', 400 );
		$finish = '';
		if ( 'date' === $repeat_end ) {
			$finish = self::clean_date( $repeat['end_date'] ?? '', 'repeat.end_date' );
			if ( is_wp_error( $finish ) ) return $finish;
		}
		$repeat_count = null;
		if ( 'occurrences' === $repeat_end ) {
			$repeat_count = (int) ( $repeat['occurrences'] ?? 0 );
			if ( $repeat_count < 1 || $repeat_count > 10000 ) return self::error( 'invalid_calendar_repeat', 'repeat.occurrences must be between 1 and 10000.', 400 );
		}
		$ids = array();
		foreach ( array( 'category_ids', 'location_ids', 'organizer_ids', 'label_ids', 'tag_ids', 'speaker_ids', 'sponsor_ids', 'additional_location_ids', 'additional_organizer_ids', 'gallery_media_ids' ) as $key ) {
			if ( array_key_exists( $key, $params ) ) {
				$ids[ $key ] = self::numeric_ids( $params[ $key ], $key, 'gallery_media_ids' === $key ? 50 : 100 );
				if ( is_wp_error( $ids[ $key ] ) ) return $ids[ $key ];
			} else {
				$map = array( 'location_ids' => 'location_id', 'organizer_ids' => 'organizer_id' );
				$ids[ $key ] = $old[ $key ] ?? array();
				if ( isset( $map[ $key ] ) && isset( $old[ $map[ $key ] ] ) && $old[ $map[ $key ] ] ) $ids[ $key ] = array( (int) $old[ $map[ $key ] ] );
			}
		}
		$location_id = isset( $params['location_id'] ) ? (int) $params['location_id'] : (int) ( $old['location_id'] ?? 0 );
		$organizer_id = isset( $params['organizer_id'] ) ? (int) $params['organizer_id'] : (int) ( $old['organizer_id'] ?? 0 );
		if ( array_key_exists( 'location_id', $params ) ) $ids['location_ids'] = $location_id > 0 ? array( $location_id ) : array();
		if ( array_key_exists( 'organizer_id', $params ) ) $ids['organizer_ids'] = $organizer_id > 0 ? array( $organizer_id ) : array();
		$meta = array(
			'mec_additional_location_ids' => $ids['additional_location_ids'],
			'mec_additional_organizer_ids' => $ids['additional_organizer_ids'],
			'mec_comment' => array_key_exists( 'time_comment', $params ) ? self::clean_text( $params['time_comment'], 500 ) : ( $old['time_comment'] ?? '' ),
			'mec_timezone' => array_key_exists( 'timezone', $params ) ? self::clean_text( $params['timezone'], 100 ) : ( $old['timezone'] ?? 'global' ),
			'mec_advanced_days' => is_scalar( $repeat['advanced_days'] ?? '' ) ? (string) ( $repeat['advanced_days'] ?? '' ) : '',
			'mec_in_days' => is_scalar( $repeat['in_days'] ?? '' ) ? (string) ( $repeat['in_days'] ?? '' ) : '',
			'mec_not_in_days' => is_scalar( $repeat['not_in_days'] ?? '' ) ? (string) ( $repeat['not_in_days'] ?? '' ) : '',
			'mec_more_info' => array_key_exists( 'more_info', $params ) ? esc_url_raw( (string) $params['more_info'] ) : ( $old['more_info'] ?? '' ),
			'mec_more_info_title' => array_key_exists( 'more_info_title', $params ) ? self::clean_text( $params['more_info_title'], 300 ) : ( $old['more_info_title'] ?? '' ),
			'mec_more_info_target' => array_key_exists( 'more_info_target', $params ) ? self::clean_text( $params['more_info_target'], 20 ) : ( $old['more_info_target'] ?? '_self' ),
			'mec_read_more' => array_key_exists( 'read_more', $params ) ? esc_url_raw( (string) $params['read_more'] ) : ( $old['read_more'] ?? '' ),
			'mec_cost' => array_key_exists( 'cost', $params ) ? self::clean_text( $params['cost'], 100 ) : ( $old['cost'] ?? '' ),
			'mec_color' => array_key_exists( 'color', $params ) ? ltrim( self::clean_text( $params['color'], 16 ), '#' ) : ( $old['color'] ?? '' ),
		);
		$args = array(
			'title' => $title, 'content' => $content, 'status' => $status,
			'author' => array_key_exists( 'author_id', $params ) ? (int) $params['author_id'] : null,
			'location_id' => $location_id ?: 1, 'organizer_id' => $organizer_id ?: 1,
			'start' => $start_date, 'end' => $end_date,
			'start_time_hour' => $start_time[0], 'start_time_minutes' => $start_time[1], 'start_time_ampm' => $start_time[2],
			'end_time_hour' => $end_time[0], 'end_time_minutes' => $end_time[1], 'end_time_ampm' => $end_time[2],
			'allday' => array_key_exists( 'all_day', $params ) ? ( ! empty( $params['all_day'] ) ? 1 : 0 ) : ( ! empty( $old['all_day'] ) ? 1 : 0 ),
			'time_comment' => array_key_exists( 'time_comment', $params ) ? self::clean_text( $params['time_comment'], 500 ) : ( $old['time_comment'] ?? '' ),
			'repeat_status' => $repeat_enabled ? 1 : 0, 'repeat_type' => $repeat_enabled ? $repeat_type : '', 'interval' => $interval,
			'finish' => $finish, 'repeat_count' => $repeat_count,
			'weekdays' => is_array( $repeat['weekdays'] ?? null ) ? implode( ',', array_map( 'intval', $repeat['weekdays'] ) ) : (string) ( $repeat['weekdays'] ?? '' ),
			'advanced_days' => is_scalar( $repeat['advanced_days'] ?? '' ) ? (string) ( $repeat['advanced_days'] ?? '' ) : '',
			'in_days' => is_scalar( $repeat['in_days'] ?? '' ) ? (string) ( $repeat['in_days'] ?? '' ) : '',
			'not_in_days' => is_scalar( $repeat['not_in_days'] ?? '' ) ? (string) ( $repeat['not_in_days'] ?? '' ) : '',
			'meta' => $meta,
		);
		$args['date'] = array(
			'start' => array( 'date' => $start_date, 'hour' => $start_time[0], 'minutes' => $start_time[1], 'ampm' => $start_time[2] ),
			'end' => array( 'date' => $end_date, 'hour' => $end_time[0], 'minutes' => $end_time[1], 'ampm' => $end_time[2] ),
			'repeat' => array(),
			'allday' => $args['allday'],
			'hide_time' => array_key_exists( 'hide_time', $params ) ? ( ! empty( $params['hide_time'] ) ? 1 : 0 ) : ( ! empty( $old['hide_time'] ) ? 1 : 0 ),
			'hide_end_time' => array_key_exists( 'hide_end_time', $params ) ? ( ! empty( $params['hide_end_time'] ) ? 1 : 0 ) : ( ! empty( $old['hide_end_time'] ) ? 1 : 0 ),
			'comment' => $args['time_comment'],
		);
		return array( 'args' => $args, 'ids' => $ids, 'status' => $status, 'excerpt' => array_key_exists( 'excerpt', $params ) ? wp_kses_post( (string) $params['excerpt'] ) : ( $old['excerpt'] ?? '' ), 'featured_media' => array_key_exists( 'featured_media', $params ) ? (int) $params['featured_media'] : (int) ( $old['featured_media'] ?? 0 ), 'has_gallery' => array_key_exists( 'gallery_media_ids', $params ), 'scheduled_for_gmt' => $params['scheduled_for_gmt'] ?? null );
	}

	private static function assign_terms( $post_id, $ids ) {
		$map = array( 'category_ids' => 'mec_category', 'location_ids' => 'mec_location', 'organizer_ids' => 'mec_organizer', 'label_ids' => 'mec_label', 'tag_ids' => 'mec_tag', 'speaker_ids' => 'mec_speaker', 'sponsor_ids' => 'mec_sponsor' );
		foreach ( $map as $key => $taxonomy ) {
			if ( ! array_key_exists( $key, $ids ) || ! taxonomy_exists( $taxonomy ) ) continue;
			$result = wp_set_object_terms( $post_id, $ids[ $key ], $taxonomy, false );
			if ( is_wp_error( $result ) ) return $result;
		}
		return true;
	}

	private static function save_event( $params, $event_id = null ) {
		$current = $event_id ? self::event_data( $event_id ) : null;
		$payload = self::payload_args( $params, $current, ! $event_id );
		if ( is_wp_error( $payload ) ) return $payload;
		$scheduled_timestamp = null;
		if ( isset( $payload['scheduled_for_gmt'] ) && is_string( $payload['scheduled_for_gmt'] ) && $payload['scheduled_for_gmt'] !== '' ) {
			$scheduled_timestamp = strtotime( $payload['scheduled_for_gmt'] );
			if ( ! $scheduled_timestamp || $scheduled_timestamp <= time() ) return self::error( 'invalid_calendar_schedule', 'scheduled_for_gmt must be a future ISO-8601 timestamp.', 400 );
		}
		if ( 'future' === $payload['status'] && ! $scheduled_timestamp ) return self::error( 'calendar_schedule_time_required', 'scheduled_for_gmt is required when status is future.', 400 );
		if ( $event_id ) {
			if ( empty( $params['expected_calendar_sha256'] ) ) return self::error( 'calendar_version_required', 'expected_calendar_sha256 is required when updating an existing calendar event.', 409 );
			$expected = strtolower( (string) $params['expected_calendar_sha256'] );
			$actual = self::response( $current )['calendar_sha256'];
			if ( ! preg_match( '/^[a-f0-9]{64}$/', $expected ) || ! hash_equals( $actual, $expected ) ) return self::error( 'calendar_event_changed', 'Calendar event changed since it was read. Read it again before applying the edit.', 409, array( 'calendar_sha256' => $actual ) );
		}
		$main = self::main();
		$id = $main->save_event( $payload['args'], $event_id );
		if ( is_wp_error( $id ) ) return $id;
		if ( $payload['excerpt'] !== '' || array_key_exists( 'excerpt', $params ) ) wp_update_post( array( 'ID' => $id, 'post_excerpt' => $payload['excerpt'] ) );
		$terms = self::assign_terms( $id, $payload['ids'] );
		if ( is_wp_error( $terms ) ) return $terms;
		if ( array_key_exists( 'featured_media', $params ) ) {
			if ( $payload['featured_media'] > 0 ) set_post_thumbnail( $id, $payload['featured_media'] );
			else delete_post_thumbnail( $id );
		}
		if ( $payload['has_gallery'] ) update_post_meta( $id, 'mec_event_gallery', $payload['ids']['gallery_media_ids'] );
		if ( $scheduled_timestamp ) {
			wp_update_post( array( 'ID' => $id, 'post_status' => 'future', 'post_date_gmt' => gmdate( 'Y-m-d H:i:s', $scheduled_timestamp ), 'post_date' => get_date_from_gmt( gmdate( 'Y-m-d H:i:s', $scheduled_timestamp ) ) ) );
		}
		$data = self::event_data( $id );
		return self::response( $data );
	}

	public static function create_event( WP_REST_Request $request ) {
		return rest_ensure_response( self::save_event( self::json_params( $request ) ) );
	}

	public static function update_event( WP_REST_Request $request ) {
		return rest_ensure_response( self::save_event( self::json_params( $request ), (int) $request['id'] ) );
	}

	private static function taxonomy_from_slug( $slug ) {
		$slug = sanitize_key( $slug );
		return self::$taxonomies[ $slug ] ?? null;
	}

	public static function list_terms( WP_REST_Request $request ) {
		$taxonomy = self::taxonomy_from_slug( $request['taxonomy'] );
		if ( ! $taxonomy || ! taxonomy_exists( $taxonomy ) ) return self::error( 'calendar_taxonomy_not_found', 'The requested MEC taxonomy is not available.', 404 );
		$per_page = max( 1, min( 100, (int) ( $request->get_param( 'per_page' ) ?: 50 ) ) );
		$page = max( 1, min( 10000, (int) ( $request->get_param( 'page' ) ?: 1 ) ) );
		$terms = get_terms( array( 'taxonomy' => $taxonomy, 'hide_empty' => false, 'number' => $per_page, 'offset' => ( $page - 1 ) * $per_page, 'search' => self::clean_text( $request->get_param( 'search' ), 200 ), 'orderby' => 'name', 'order' => 'ASC' ) );
		if ( is_wp_error( $terms ) ) return $terms;
		$total = wp_count_terms( array( 'taxonomy' => $taxonomy, 'hide_empty' => false, 'search' => self::clean_text( $request->get_param( 'search' ), 200 ) ) );
		return rest_ensure_response( array( 'taxonomy' => $request['taxonomy'], 'terms' => array_values( array_filter( array_map( function ( $term ) use ( $taxonomy ) { return self::term_summary( $term, $taxonomy ); }, $terms ) ) ), 'page' => $page, 'per_page' => $per_page, 'total' => (int) $total, 'total_pages' => $per_page ? (int) ceil( (int) $total / $per_page ) : 1 ) );
	}

	public static function create_term( WP_REST_Request $request ) {
		$taxonomy = self::taxonomy_from_slug( $request['taxonomy'] );
		if ( ! $taxonomy || ! taxonomy_exists( $taxonomy ) ) return self::error( 'calendar_taxonomy_not_found', 'The requested MEC taxonomy is not available.', 404 );
		$params = self::json_params( $request );
		$name = self::clean_text( $params['name'] ?? '', 200 );
		if ( '' === $name ) return self::error( 'calendar_term_name_required', 'name is required.', 400 );
		$args = array();
		if ( isset( $params['slug'] ) ) $args['slug'] = sanitize_title( $params['slug'] );
		if ( isset( $params['description'] ) ) $args['description'] = sanitize_textarea_field( (string) $params['description'] );
		$result = wp_insert_term( $name, $taxonomy, $args );
		if ( is_wp_error( $result ) ) return $result;
		$id = (int) $result['term_id'];
		$meta_keys = array( 'address', 'latitude', 'longitude', 'tel', 'email', 'url', 'thumbnail', 'opening_hour', 'job_title', 'website', 'type' );
		foreach ( $meta_keys as $key ) if ( array_key_exists( $key, $params ) ) update_term_meta( $id, $key, sanitize_text_field( (string) $params[ $key ] ) );
		return rest_ensure_response( array( 'taxonomy' => $request['taxonomy'], 'term' => self::term_summary( get_term( $id, $taxonomy ), $taxonomy ) ) );
	}
}

WPBridge_MEC_Helper::init();
