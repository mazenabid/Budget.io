$(document).ready(function() {
    $('.transaction-row').slice(0, 5).show();
    $('#show-more-transactions').on('click', function() {
        if ($(this).text() === 'Show More') {
            $('.transaction-row:hidden').slice(0, 5).slideDown();
            if ($('.transaction-row:hidden').length == 0) {
                $(this).text('Show Less');
            }
        } else {
            $('.transaction-row').slice(5).slideUp();
            $(this).text('Show More');
        }
    });
});