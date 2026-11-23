<?php
/**
 * Standalone regression harness for wordpress/wpbridge-mec-helper.
 *
 * It loads the real helper with minimal WordPress stubs and a fake MEC main
 * library that mirrors the parts of MEC's save_event() and WordPress's
 * wp_insert_post() the helper depends on: MEC passes only title, content, type
 * and status; WordPress then defaults the author to the current user, clears
 * the password, turns 'future' without a future date into 'publish', and runs
 * wp_insert_post_data. MEC builds its mec_events SQL by string concatenation.
 *
 * This is not a WordPress integration test. Run: php test/php/mec-helper-harness.php
 */

define( 'ABSPATH', __DIR__ . '/' );

// ---------------------------------------------------------------- state

$GLOBALS['t'] = array();
function t_reset() {
	$GLOBALS['t'] = array(
		'user'        => 7,
		'caps'        => array( 'edit_mec_events', 'create_mec_events', 'publish_mec_events', 'edit_others_mec_events', 'assign_mec_terms' ),
		'post_caps'   => array(),
		'posts'       => array(),
		'meta'        => array(),
		'terms'       => array(),
		'object_terms'=> array(),
		'filters'     => array(),
		'sql'         => array(),
		'mec_rows'    => array(),
		'status_log'  => array(),
		'next_id'     => 500,
		'mec_throws'  => false,
	);
}
t_reset();

function t_post( $id, $fields ) {
	$GLOBALS['t']['posts'][ $id ] = (object) array_merge( array(
		'ID' => $id, 'post_type' => 'mec-events', 'post_status' => 'draft', 'post_author' => 7,
		'post_title' => 'Event', 'post_content' => '', 'post_excerpt' => '', 'post_password' => '',
		'post_name' => '', 'post_date' => '2026-01-01 10:00:00', 'post_date_gmt' => '2026-01-01 10:00:00',
		'post_parent' => 0, 'menu_order' => 0, 'comment_status' => 'open', 'ping_status' => 'open',
		'post_content_filtered' => '', 'post_mime_type' => '', 'to_ping' => '', 'pinged' => '',
	), $fields );
}

function t_event( $id, $fields = array() ) {
	t_post( $id, $fields );
	$GLOBALS['t']['meta'][ $id ] = array(
		'mec_start_date' => '2026-12-01', 'mec_end_date' => '2026-12-01',
		'mec_start_time_hour' => '8', 'mec_start_time_minutes' => '0', 'mec_start_time_ampm' => 'AM',
		'mec_end_time_hour' => '6', 'mec_end_time_minutes' => '0', 'mec_end_time_ampm' => 'PM',
		'mec_repeat_status' => '0', 'mec_repeat_interval' => '1',
	);
	$GLOBALS['t']['post_caps']['read_post'][ $id ] = true;
	$GLOBALS['t']['post_caps']['edit_post'][ $id ] = true;
}

// ---------------------------------------------------------------- WordPress stubs

class WP_Error {
	public $code; public $message; public $data;
	public function __construct( $code = '', $message = '', $data = null ) { $this->code = $code; $this->message = $message; $this->data = $data; }
	public function get_error_code() { return $this->code; }
}
class WP_Term {
	public $term_id; public $name; public $slug = ''; public $description = ''; public $taxonomy; public $count = 0;
	public function __construct( $id, $taxonomy ) { $this->term_id = $id; $this->name = 'Term ' . $id; $this->taxonomy = $taxonomy; }
}
class WP_REST_Server { const READABLE = 'GET'; const CREATABLE = 'POST'; }
class WP_REST_Request implements ArrayAccess {
	private $params; private $json;
	public function __construct( $params = array(), $json = array() ) { $this->params = $params; $this->json = $json; }
	public function get_json_params() { return $this->json; }
	public function get_param( $key ) { return $this->params[ $key ] ?? null; }
	// Attributes stay on their own lines: PHP 7.4 reads #[ as a line comment.
	#[\ReturnTypeWillChange]
	public function offsetExists( $key ) { return isset( $this->params[ $key ] ); }
	#[\ReturnTypeWillChange]
	public function offsetGet( $key ) { return $this->params[ $key ] ?? null; }
	#[\ReturnTypeWillChange]
	public function offsetSet( $key, $value ) { $this->params[ $key ] = $value; }
	#[\ReturnTypeWillChange]
	public function offsetUnset( $key ) { unset( $this->params[ $key ] ); }
}

function add_action() {}
function register_rest_route() {}
function add_filter( $hook, $callback, $priority = 10, $args = 1 ) { $GLOBALS['t']['filters'][ $hook ][] = array( $callback, $priority, $args ); return true; }
function remove_filter( $hook, $callback, $priority = 10 ) {
	foreach ( $GLOBALS['t']['filters'][ $hook ] ?? array() as $i => $f ) {
		if ( $f[0] === $callback && $f[1] === $priority ) { unset( $GLOBALS['t']['filters'][ $hook ][ $i ] ); return true; }
	}
	return false;
}
/** Runs callbacks by priority, then in the order they were added, like WP_Hook. */
function apply_filters( $hook, $value, ...$rest ) {
	$callbacks = $GLOBALS['t']['filters'][ $hook ] ?? array();
	$keys = array_keys( $callbacks );
	usort( $keys, function ( $a, $b ) use ( $callbacks ) { return array( $callbacks[ $a ][1], $a ) <=> array( $callbacks[ $b ][1], $b ); } );
	foreach ( $keys as $k ) $value = call_user_func_array( $callbacks[ $k ][0], array_slice( array_merge( array( $value ), $rest ), 0, $callbacks[ $k ][2] ) );
	return $value;
}
function is_wp_error( $v ) { return $v instanceof WP_Error; }
function rest_ensure_response( $v ) { return $v; }
function post_type_exists( $type ) { return 'mec-events' === $type; }
function get_post_type_object( $type ) {
	return 'mec-events' === $type ? (object) array( 'cap' => (object) array(
		'edit_posts' => 'edit_mec_events', 'create_posts' => 'create_mec_events', 'publish_posts' => 'publish_mec_events',
		'edit_others_posts' => 'edit_others_mec_events', 'read_private_posts' => 'read_private_mec_events',
	) ) : null;
}
function current_user_can( $cap, $id = null ) {
	if ( null !== $id ) return ! empty( $GLOBALS['t']['post_caps'][ $cap ][ $id ] );
	return in_array( $cap, $GLOBALS['t']['caps'], true );
}
function get_current_user_id() { return $GLOBALS['t']['user']; }
function get_userdata( $id ) { return in_array( (int) $id, array( 7, 23, 31 ), true ) ? (object) array( 'ID' => (int) $id ) : false; }
function get_post( $id ) { return $GLOBALS['t']['posts'][ is_object( $id ) ? $id->ID : (int) $id ] ?? null; }
function get_post_meta( $id, $key, $single = false ) { return $GLOBALS['t']['meta'][ $id ][ $key ] ?? ''; }
function update_post_meta( $id, $key, $value ) { $GLOBALS['t']['meta'][ $id ][ $key ] = $value; return true; }
function get_term_meta() { return ''; }
function get_permalink( $id ) { return 'https://example.test/?p=' . $id; }
function get_post_modified_time() { return '2026-01-01T00:00:00+00:00'; }
function get_post_thumbnail_id( $id ) { return (int) ( $GLOBALS['t']['meta'][ $id ]['_thumbnail_id'] ?? 0 ); }
function set_post_thumbnail( $id, $media ) { $GLOBALS['t']['meta'][ $id ]['_thumbnail_id'] = $media; return true; }
function delete_post_thumbnail( $id ) { unset( $GLOBALS['t']['meta'][ $id ]['_thumbnail_id'] ); return true; }
function wp_attachment_is_image( $post ) { $post = get_post( $post ); return $post && 'image/png' === $post->post_mime_type; }
function sanitize_text_field( $v ) { return trim( strip_tags( (string) $v ) ); }
function sanitize_key( $v ) { return preg_replace( '/[^a-z0-9_\-]/', '', strtolower( (string) $v ) ); }
function sanitize_title( $v ) { return trim( preg_replace( '/[^a-z0-9]+/', '-', strtolower( (string) $v ) ), '-' ); }
function wp_kses_post( $v ) { return $v; }
function esc_url_raw( $v ) { return $v; }
function esc_sql( $v ) { return addslashes( $v ); }
function wp_json_encode( $v, $flags = 0 ) { return json_encode( $v, $flags ); }
function wp_slash( $v ) { return is_array( $v ) ? array_map( 'wp_slash', $v ) : ( is_string( $v ) ? addslashes( $v ) : $v ); }
function wp_unslash( $v ) { return is_array( $v ) ? array_map( 'wp_unslash', $v ) : ( is_string( $v ) ? stripslashes( $v ) : $v ); }
function get_date_from_gmt( $gmt ) { return $gmt; }
function taxonomy_exists( $taxonomy ) { return 0 === strpos( $taxonomy, 'mec_' ); }
function get_taxonomy( $taxonomy ) { return taxonomy_exists( $taxonomy ) ? (object) array( 'cap' => (object) array( 'assign_terms' => 'assign_mec_terms', 'manage_terms' => 'manage_mec_terms' ) ) : false; }
function get_term( $id, $taxonomy ) { return isset( $GLOBALS['t']['terms'][ $taxonomy ][ (int) $id ] ) ? new WP_Term( (int) $id, $taxonomy ) : null; }
function wp_get_post_terms( $id, $taxonomy ) {
	return array_map( function ( $tid ) use ( $taxonomy ) { return new WP_Term( $tid, $taxonomy ); }, $GLOBALS['t']['object_terms'][ $id ][ $taxonomy ] ?? array() );
}
function wp_set_object_terms( $id, $terms, $taxonomy ) {
	$GLOBALS['t']['object_terms'][ $id ][ $taxonomy ] = array_values( array_filter( $terms, function ( $tid ) use ( $taxonomy ) { return isset( $GLOBALS['t']['terms'][ $taxonomy ][ $tid ] ); } ) );
	return $GLOBALS['t']['object_terms'][ $id ][ $taxonomy ];
}

/**
 * The wp_insert_post() behaviour that matters here (defaults applied, not merged).
 * As in WordPress, the second filter argument is the sanitized array (here the
 * content goes through kses' stripslashes/addslashes round trip, as MEC passes
 * unslashed values) and the third is the array exactly as the caller passed it.
 * wp_insert_post_empty_content runs first, so hooks can insert other posts
 * before this insert reaches wp_insert_post_data.
 */
function wp_insert_post( $postarr ) {
	$raw = $postarr;
	$update = ! empty( $postarr['ID'] );
	$postarr = array_merge( array( 'post_title' => '', 'post_content' => '', 'post_status' => 'draft', 'post_type' => 'post', 'post_author' => get_current_user_id() ), $postarr );
	$postarr['post_content'] = addslashes( stripslashes( $postarr['post_content'] ) );
	apply_filters( 'wp_insert_post_empty_content', false, $postarr );
	$now = gmdate( 'Y-m-d H:i:s' );
	$status = $postarr['post_status'];
	if ( 'future' === $status ) $status = 'publish'; // no post_date passed, so it is not in the future
	$draft = in_array( $status, array( 'draft', 'pending' ), true );
	$data = array(
		'post_author' => get_current_user_id(), 'post_date' => $now, 'post_date_gmt' => $draft ? '0000-00-00 00:00:00' : $now,
		'post_content' => $postarr['post_content'], 'post_title' => $postarr['post_title'], 'post_excerpt' => '',
		'post_status' => $status, 'post_type' => $postarr['post_type'], 'post_password' => '',
		'post_name' => $draft ? '' : sanitize_title( $postarr['post_title'] ), 'post_parent' => 0, 'menu_order' => 0,
		'comment_status' => 'closed', 'ping_status' => 'closed', 'post_content_filtered' => '', 'post_mime_type' => '', 'to_ping' => '', 'pinged' => '',
	);
	$data = wp_unslash( apply_filters( 'wp_insert_post_data', $data, $postarr, $raw, $update ) );
	$id = $update ? (int) $postarr['ID'] : $GLOBALS['t']['next_id']++;
	if ( '' === $data['post_name'] && ! in_array( $data['post_status'], array( 'draft', 'pending' ), true ) ) $data['post_name'] = sanitize_title( $data['post_title'] );
	t_post( $id, array_merge( $data, array( 'ID' => $id ) ) );
	$GLOBALS['t']['status_log'][] = $data['post_status'];
	return $id;
}

/** Mirrors the parts of MEC's app/libraries/main.php save_event() used by the helper. */
class Fake_MEC_Main {
	public function save_event( $event = array(), $post_id = null ) {
		if ( $GLOBALS['t']['mec_throws'] ) throw new RuntimeException( 'MEC failed' );
		$post = array( 'post_title' => $event['title'], 'post_content' => $event['content'] ?? '', 'post_type' => 'mec-events', 'post_status' => $event['status'] ?? 'publish' );
		if ( ! is_null( $post_id ) ) $post['ID'] = $post_id;
		$post_id = wp_insert_post( $post );
		update_post_meta( $post_id, 'mec_start_date', $event['start'] );
		update_post_meta( $post_id, 'mec_end_date', $event['end'] );
		update_post_meta( $post_id, 'mec_certain_weekdays', explode( ',', trim( ( isset( $event['weekdays'] ) ? $event['weekdays'] : '' ), ', ' ) ) );
		$not_in_days = isset( $event['not_in_days'] ) ? $event['not_in_days'] : '';
		$mec = array(
			'post_id' => $post_id, 'start' => $event['start'], 'repeat' => $event['repeat_status'], 'rinterval' => $event['interval'],
			'end' => ( isset( $event['finish'] ) && trim( $event['finish'] ) ) ? $event['finish'] : '0000-00-00',
			'weekdays' => isset( $event['weekdays'] ) ? $event['weekdays'] : null,
			'days' => isset( $event['days'] ) ? $event['days'] : '', 'not_in_days' => $not_in_days,
		);
		$q = '';
		foreach ( $mec as $key => $value ) $q .= is_null( $value ) ? "`$key`=NULL," : "`$key`='$value',";
		$GLOBALS['t']['sql'][] = 'UPDATE `wp_mec_events` SET ' . trim( $q, ', ' );
		$GLOBALS['t']['mec_rows'][] = $mec;
		if ( isset( $event['meta'] ) && is_array( $event['meta'] ) ) foreach ( $event['meta'] as $key => $value ) update_post_meta( $post_id, $key, $value );
		return $post_id;
	}
}
class MEC {
	public static function getInstance( $name ) { return new Fake_MEC_Main(); }
}

require dirname( __DIR__, 2 ) . '/wordpress/wpbridge-mec-helper/wpbridge-mec-helper.php';

// ---------------------------------------------------------------- tiny runner

$failures = 0;
$count = 0;
function check( $name, $condition, $detail = '' ) {
	global $failures, $count;
	$count++;
	if ( $condition ) { echo "ok - $name\n"; return; }
	$failures++;
	echo "not ok - $name" . ( '' !== $detail ? " ($detail)" : '' ) . "\n";
}
function status_of( $result ) { return $result instanceof WP_Error ? (int) ( $result->data['status'] ?? 0 ) : 200; }
function code_of( $result ) { return $result instanceof WP_Error ? $result->code : ''; }
function create( $body ) { return WPBridge_MEC_Helper::create_event( new WP_REST_Request( array(), $body ) ); }
function read( $id ) { return WPBridge_MEC_Helper::get_event( new WP_REST_Request( array( 'id' => $id ) ) ); }
function update( $id, $body ) {
	$body['expected_calendar_sha256'] = read( $id )['calendar_sha256'];
	return WPBridge_MEC_Helper::update_event( new WP_REST_Request( array( 'id' => $id ), $body ) );
}
function no_insert_filters() { return empty( $GLOBALS['t']['filters']['wp_insert_post_data'] ); }

// ---------------------------------------------------------------- recurrence values reaching MEC's SQL

$injections = array(
	'not_in_days string' => array( 'not_in_days' => "x' WHERE id<>0 -- " ),
	'not_in_days array'  => array( 'not_in_days' => array( '2026-12-24', "2026-12-25' OR '1'='1" ) ),
	'weekdays string'    => array( 'weekdays' => "1,3' OR 1=1 -- " ),
	'weekdays array'     => array( 'weekdays' => array( 1, '2 OR 1=1' ) ),
	'weekdays range'     => array( 'weekdays' => array( 0, 8 ) ),
	'in_days string'     => array( 'in_days' => "2026-12-01:2026-12-02',`post_id`=1 -- " ),
	'in_days bad date'   => array( 'in_days' => array( '2026-02-30:2026-03-01' ) ),
	'in_days reversed'   => array( 'in_days' => array( '2026-03-02:2026-03-01' ) ),
	'advanced_days'      => array( 'advanced_days' => "Mon.1' OR 1=1" ),
	'object item'        => array( 'not_in_days' => array( array( 'x' ) ) ),
	'trailing newline'   => array( 'not_in_days' => array( "2026-12-24\n' --" ) ),
);
foreach ( $injections as $label => $repeat ) {
	t_reset();
	t_event( 41, array( 'post_author' => 7 ) );
	$before = $GLOBALS['t']['posts'][41];
	$result = update( 41, array( 'repeat' => array_merge( array( 'enabled' => true, 'type' => 'daily' ), $repeat ) ) );
	check( "rejects $label with 400 before any write", 400 === status_of( $result ) && 'invalid_calendar_repeat' === code_of( $result ) && ! $GLOBALS['t']['sql'] && $before === $GLOBALS['t']['posts'][41], code_of( $result ) );
}

t_reset();
t_event( 42 );
$result = update( 42, array( 'repeat' => array(
	'enabled' => true, 'type' => 'certain_weekdays', 'weekdays' => array( '5', 1, '3', 3 ),
	'in_days' => '2026-12-01:2026-12-02:8-05-am:6-00-PM,2026-11-01:2026-11-01',
	'not_in_days' => array( '2026-12-25', '2026-12-24' ), 'advanced_days' => 'Mon.1-Fri.l',
) ) );
$row = end( $GLOBALS['t']['mec_rows'] );
$meta = $GLOBALS['t']['meta'][42];
check( 'valid recurrence saves', 200 === status_of( $result ), code_of( $result ) );
check( 'weekdays use MEC column format', ',1,3,5,' === $row['weekdays'], (string) $row['weekdays'] );
check( 'custom days normalized and sent as days', '2026-11-01:2026-11-01,2026-12-01:2026-12-02:08-05-AM:06-00-PM' === $row['days'], $row['days'] );
check( 'excluded days sorted', '2026-12-24,2026-12-25' === $row['not_in_days'], $row['not_in_days'] );
check( 'weekday meta is an integer array', array( 1, 3, 5 ) === $meta['mec_certain_weekdays'] );
check( 'advanced days meta is an array', array( 'Mon.1', 'Fri.l' ) === $meta['mec_advanced_days'] );
check( 'no quote reaches the SQL values', false === strpos( implode( '', array_map( 'strval', $row ) ), "'" ) );

t_reset();
t_event( 43 );
$result = update( 43, array( 'repeat' => array( 'enabled' => false ) ) );
$row = end( $GLOBALS['t']['mec_rows'] );
check( 'empty recurrence sends NULL weekdays', 200 === status_of( $result ) && null === $row['weekdays'] && '' === $row['days'] && '' === $row['not_in_days'] );

// Values read back from meta (array weekdays incl. MEC's empty item, comma strings) round-trip.
t_reset();
t_event( 44 );
$GLOBALS['t']['meta'][44] += array( 'mec_certain_weekdays' => array( '' ), 'mec_in_days' => '', 'mec_not_in_days' => '2026-12-24', 'mec_advanced_days' => '' );
$result = update( 44, array( 'title' => 'Renamed' ) );
check( 'stored recurrence round-trips on an unrelated edit', 200 === status_of( $result ) && '2026-12-24' === end( $GLOBALS['t']['mec_rows'] )['not_in_days'], code_of( $result ) );

t_reset();
t_event( 45 );
$GLOBALS['t']['meta'][45]['mec_not_in_days'] = "2026-12-24' OR 1=1";
$result = update( 45, array( 'title' => 'Renamed' ) );
check( 'stored invalid recurrence is not replayed into SQL', 400 === status_of( $result ) && ! $GLOBALS['t']['sql'] );

// ---------------------------------------------------------------- author, password, core fields

t_reset();
t_event( 50, array( 'post_author' => 23, 'post_status' => 'publish', 'post_password' => 'pa\'ss', 'post_name' => 'kept-slug', 'post_excerpt' => 'Old excerpt', 'post_parent' => 9, 'menu_order' => 4, 'comment_status' => 'open' ) );
$result = update( 50, array( 'title' => 'New title' ) );
$saved = $GLOBALS['t']['posts'][50];
check( 'edit by another user keeps the author', 200 === status_of( $result ) && 23 === (int) $saved->post_author, (string) $saved->post_author );
check( 'edit keeps the post password', 'pa\'ss' === $saved->post_password, $saved->post_password );
check( 'edit keeps slug, date, parent, order, comments and excerpt', 'kept-slug' === $saved->post_name && '2026-01-01 10:00:00' === $saved->post_date_gmt && 9 === (int) $saved->post_parent && 4 === (int) $saved->menu_order && 'open' === $saved->comment_status && 'Old excerpt' === $saved->post_excerpt );
check( 'edit applies the new title', 'New title' === $saved->post_title );
check( 'insert filter removed after save', no_insert_filters() );

t_reset();
t_event( 51, array( 'post_author' => 23 ) );
$result = update( 51, array( 'author_id' => 31 ) );
check( 'explicit author_id is applied', 200 === status_of( $result ) && 31 === (int) $GLOBALS['t']['posts'][51]->post_author );

t_reset();
t_event( 52, array( 'post_status' => 'publish', 'post_password' => 'secret' ) );
$result = update( 52, array( 'status' => 'private' ) );
check( 'making an event private clears its password like WordPress', 200 === status_of( $result ) && 'private' === $GLOBALS['t']['posts'][52]->post_status && '' === $GLOBALS['t']['posts'][52]->post_password );

t_reset();
$result = create( array( 'title' => 'Fresh', 'excerpt' => 'Short' ) );
$new = $GLOBALS['t']['posts'][500] ?? null;
check( 'create without author_id uses the current user', 200 === status_of( $result ) && $new && 7 === (int) $new->post_author && 'Short' === $new->post_excerpt );

t_reset();
$result = create( array( 'title' => 'Fresh', 'author_id' => 23 ) );
check( 'create with author_id applies it', 200 === status_of( $result ) && 23 === (int) $GLOBALS['t']['posts'][500]->post_author );

// ---------------------------------------------------------------- scheduling

t_reset();
t_event( 60, array( 'post_status' => 'draft', 'post_date_gmt' => '0000-00-00 00:00:00' ) );
$when = gmdate( 'Y-m-d H:i:s', time() + 86400 );
$result = update( 60, array( 'status' => 'future', 'scheduled_for_gmt' => str_replace( ' ', 'T', $when ) . 'Z' ) );
$saved = $GLOBALS['t']['posts'][60];
check( 'scheduling is a single write straight to future', 200 === status_of( $result ) && array( 'future' ) === $GLOBALS['t']['status_log'], implode( ',', $GLOBALS['t']['status_log'] ) );
check( 'scheduled date applied', $when === $saved->post_date_gmt && '' !== $saved->post_name );

t_reset();
$result = create( array( 'title' => 'Later', 'status' => 'future', 'scheduled_for_gmt' => gmdate( 'c', time() + 3600 ) ) );
check( 'scheduled create never writes publish', 200 === status_of( $result ) && array( 'future' ) === $GLOBALS['t']['status_log'], implode( ',', $GLOBALS['t']['status_log'] ) );

t_reset();
t_event( 61, array( 'post_status' => 'future', 'post_date_gmt' => gmdate( 'Y-m-d H:i:s', time() + 86400 ) ) );
$result = update( 61, array( 'status' => 'publish' ) );
check( 'publishing a scheduled event does not keep its future date', 200 === status_of( $result ) && 'publish' === $GLOBALS['t']['posts'][61]->post_status && strtotime( $GLOBALS['t']['posts'][61]->post_date_gmt ) <= time() );

// ---------------------------------------------------------------- the filter is scoped and always removed

t_reset();
t_event( 70 );
t_post( 71, array( 'post_author' => 99 ) );
add_filter( 'wp_insert_post_data', function ( $data ) { return $data; }, 10, 1 );
$GLOBALS['t']['mec_throws'] = true;
try { update( 70, array( 'title' => 'x' ) ); $threw = false; } catch ( RuntimeException $e ) { $threw = true; }
check( 'filter removed when MEC throws', $threw && 1 === count( $GLOBALS['t']['filters']['wp_insert_post_data'] ) );
$GLOBALS['t']['mec_throws'] = false;
$other = wp_insert_post( array( 'ID' => 71, 'post_title' => 'Other', 'post_type' => 'mec-events', 'post_status' => 'draft' ) );
check( 'other inserts are untouched afterwards', 7 === (int) $GLOBALS['t']['posts'][71]->post_author );

// Values that WordPress slashes or sanitizes still match what MEC was given.
t_reset();
$result = create( array( 'title' => 'It\'s "on"', 'content' => '<p>Don\'t miss it</p>', 'excerpt' => 'Sam\'s pick', 'author_id' => 23 ) );
$new = $GLOBALS['t']['posts'][500] ?? null;
check( 'create with quotes applies author and excerpt', 200 === status_of( $result ) && $new && 23 === (int) $new->post_author && 'Sam\'s pick' === $new->post_excerpt && '<p>Don\'t miss it</p>' === $new->post_content, code_of( $result ) );

/**
 * Installs a wp_insert_post_data (or other) callback, added before the helper's
 * guard and so run first at the same priority, that inserts one other mec-events
 * post while the first insert it sees is in progress.
 */
function t_nested_insert( $hook, $postarr ) {
	$GLOBALS['t']['nested_done'] = false;
	add_filter( $hook, function ( $value ) use ( $postarr ) {
		if ( ! $GLOBALS['t']['nested_done'] ) {
			$GLOBALS['t']['nested_done'] = true;
			$GLOBALS['t']['nested_id'] = wp_insert_post( $postarr );
		}
		return $value;
	}, PHP_INT_MIN, 1 );
}
$nested_cases = array(
	'different event from an earlier wp_insert_post_data callback' => array( 'wp_insert_post_data', array( 'post_title' => 'Companion', 'post_content' => '', 'post_type' => 'mec-events', 'post_status' => 'draft' ) ),
	'identical event from an earlier wp_insert_post_data callback' => array( 'wp_insert_post_data', array( 'post_title' => 'Fresh', 'post_content' => '', 'post_type' => 'mec-events', 'post_status' => 'draft' ) ),
	'identical event from a hook before wp_insert_post_data'       => array( 'wp_insert_post_empty_content', array( 'post_title' => 'Fresh', 'post_content' => '', 'post_type' => 'mec-events', 'post_status' => 'draft' ) ),
);
foreach ( $nested_cases as $label => $case ) {
	t_reset();
	t_nested_insert( $case[0], $case[1] );
	$result = create( array( 'title' => 'Fresh', 'excerpt' => 'Short', 'author_id' => 23 ) );
	$nested = $GLOBALS['t']['posts'][ $GLOBALS['t']['nested_id'] ?? 0 ] ?? null;
	$intended = is_array( $result ) ? ( $GLOBALS['t']['posts'][ $result['event']['id'] ?? 0 ] ?? null ) : null;
	check( "nested insert ($label) does not get the overrides", $nested && 7 === (int) $nested->post_author && '' === $nested->post_excerpt && 'draft' === $nested->post_status );
	check( "intended event still gets them ($label)", 200 === status_of( $result ) && $intended && $intended !== $nested && 23 === (int) $intended->post_author && 'Short' === $intended->post_excerpt, code_of( $result ) );
}

t_reset();
t_nested_insert( 'wp_insert_post_data', array( 'post_title' => 'Later', 'post_content' => '', 'post_type' => 'mec-events', 'post_status' => 'draft' ) );
$when = gmdate( 'Y-m-d H:i:s', time() + 3600 );
$result = create( array( 'title' => 'Later', 'status' => 'future', 'scheduled_for_gmt' => str_replace( ' ', 'T', $when ) . 'Z' ) );
$nested = $GLOBALS['t']['posts'][ $GLOBALS['t']['nested_id'] ] ?? null;
$intended = $GLOBALS['t']['posts'][501] ?? null;
check( 'nested insert during a scheduled create is not scheduled', $nested && 'draft' === $nested->post_status && '0000-00-00 00:00:00' === $nested->post_date_gmt );
check( 'the scheduled event is', 200 === status_of( $result ) && $intended && 'future' === $intended->post_status && $when === $intended->post_date_gmt, code_of( $result ) );

// A nested update of the event being edited does not take its overrides either.
t_reset();
t_event( 72, array( 'post_author' => 23, 'post_excerpt' => 'Kept' ) );
t_nested_insert( 'wp_insert_post_data', array( 'ID' => 72, 'post_title' => 'Event', 'post_content' => '', 'post_type' => 'mec-events', 'post_status' => 'draft' ) );
$result = update( 72, array( 'title' => 'Event' ) );
check( 'nested update of the same event does not consume the guard', 200 === status_of( $result ) && 23 === (int) $GLOBALS['t']['posts'][72]->post_author && 'Kept' === $GLOBALS['t']['posts'][72]->post_excerpt, code_of( $result ) );

// Every overridden field is verified, so a lost override cannot return 200.
t_reset();
add_filter( 'wp_insert_post_data', function ( $data ) { $data['post_excerpt'] = ''; return $data; }, 10, 1 );
$result = create( array( 'title' => 'Fresh', 'excerpt' => 'Short' ) );
check( 'lost excerpt on create is reported, not 200', 500 === status_of( $result ) && 'calendar_save_unverified' === code_of( $result ) && in_array( 'post_excerpt', $result->data['fields'], true ), code_of( $result ) );

t_reset();
t_event( 73, array( 'post_status' => 'publish', 'menu_order' => 4, 'post_name' => 'kept-slug' ) );
add_filter( 'wp_insert_post_data', function ( $data ) { $data['menu_order'] = 0; return $data; }, 10, 1 );
$result = update( 73, array( 'title' => 'Event' ) );
check( 'lost core field on update is reported, not 200', 500 === status_of( $result ) && array( 'menu_order' ) === $result->data['fields'], code_of( $result ) );
check( 'insert filters removed after the nested-insert cases', 1 === count( $GLOBALS['t']['filters']['wp_insert_post_data'] ) );

// ---------------------------------------------------------------- references are checked before the write

t_reset();
t_event( 80 );
$GLOBALS['t']['terms']['mec_category'][5] = true;
$result = update( 80, array( 'title' => 'Changed', 'category_ids' => array( 5, 999999 ) ) );
check( 'unknown category ID rejected before any write', 400 === status_of( $result ) && 'invalid_calendar_term' === code_of( $result ) && ! $GLOBALS['t']['sql'] && 'Event' === $GLOBALS['t']['posts'][80]->post_title );

t_reset();
t_event( 81 );
$GLOBALS['t']['terms']['mec_label'][6] = true;
$result = update( 81, array( 'location_ids' => array( 6 ) ) );
check( 'term from another taxonomy rejected', 400 === status_of( $result ) && ! $GLOBALS['t']['sql'] );

t_reset();
t_event( 82 );
$result = update( 82, array( 'location_id' => 1 ) );
check( 'MEC hide sentinel location_id 1 is accepted', 200 === status_of( $result ), code_of( $result ) );

t_reset();
t_event( 83 );
t_post( 900, array( 'post_type' => 'attachment', 'post_mime_type' => 'application/pdf' ) );
t_post( 901, array( 'post_type' => 'attachment', 'post_mime_type' => 'image/png' ) );
$GLOBALS['t']['post_caps']['read_post'][900] = true;
$GLOBALS['t']['post_caps']['read_post'][901] = true;
$result = update( 83, array( 'featured_media' => 900 ) );
check( 'non-image featured_media rejected before write', 400 === status_of( $result ) && ! $GLOBALS['t']['sql'] );
$result = update( 83, array( 'gallery_media_ids' => array( 901, 83 ) ) );
check( 'non-attachment gallery ID rejected before write', 400 === status_of( $result ) && ! $GLOBALS['t']['sql'] );
$result = update( 83, array( 'featured_media' => 901, 'gallery_media_ids' => array( 901 ) ) );
check( 'image attachments accepted', 200 === status_of( $result ) && 901 === get_post_thumbnail_id( 83 ), code_of( $result ) );

// ---------------------------------------------------------------- permission callbacks

t_reset();
$GLOBALS['t']['caps'] = array( 'edit_mec_events' );
check( 'create needs create_posts, not edit_posts', false === WPBridge_MEC_Helper::can_create_event() );
$GLOBALS['t']['caps'] = array( 'create_mec_events' );
check( 'create allowed with create_posts', true === WPBridge_MEC_Helper::can_create_event() );

t_reset();
t_event( 90, array( 'post_author' => 23 ) );
$GLOBALS['t']['post_caps']['read_post'][90] = false;
$GLOBALS['t']['post_caps']['edit_post'][90] = false;
t_post( 91, array( 'post_type' => 'post' ) );
$GLOBALS['t']['post_caps']['read_post'][91] = true;
$hidden = WPBridge_MEC_Helper::can_read_event( new WP_REST_Request( array( 'id' => 90 ) ) );
$missing = WPBridge_MEC_Helper::can_read_event( new WP_REST_Request( array( 'id' => 12345 ) ) );
$wrong = WPBridge_MEC_Helper::can_read_event( new WP_REST_Request( array( 'id' => 91 ) ) );
check( 'unreadable, missing and wrong-type IDs give the same 404 on GET', 404 === status_of( $hidden ) && $hidden == $missing && $missing == $wrong );
$hidden_edit = WPBridge_MEC_Helper::can_edit_event( new WP_REST_Request( array( 'id' => 90 ) ) );
check( 'unreadable event gives the same 404 on update', 404 === status_of( $hidden_edit ) && $hidden_edit == $missing );

$GLOBALS['t']['post_caps']['read_post'][90] = true;
check( 'GET uses read_post', true === WPBridge_MEC_Helper::can_read_event( new WP_REST_Request( array( 'id' => 90 ) ) ) );
check( 'update still needs edit_post', false === WPBridge_MEC_Helper::can_edit_event( new WP_REST_Request( array( 'id' => 90 ) ) ) );
$GLOBALS['t']['caps'] = array();
check( 'GET still needs editorial access', false === WPBridge_MEC_Helper::can_read_event( new WP_REST_Request( array( 'id' => 90 ) ) ) );

echo "\n$count checks, $failures failed\n";
exit( $failures ? 1 : 0 );
